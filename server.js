const express = require('express');
const path = require('path');
const session = require('express-session');
const Database = require('better-sqlite3');
const sqliteStoreFactory = require('better-sqlite3-session-store')(session);
const app = express();

// Инициализация базы данных
const db = new Database('trade.db');
db.pragma('journal_mode = WAL');

// Создание таблиц, если их нет
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        steamId TEXT PRIMARY KEY,
        apiKey TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS offers (
        id TEXT PRIMARY KEY,
        steamId TEXT NOT NULL,
        items TEXT NOT NULL,
        want TEXT NOT NULL,
        createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expire INTEGER NOT NULL
    );
`);

// Настройка хранилища сессий в SQLite
const sessionStore = new sqliteStoreFactory({
    client: db,
    expired: { clear: true, intervalMs: 900000 } // очистка каждые 15 минут
});

// Настройка сессий
app.use(session({
    secret: 'мой_секретный_ключ_для_сессий',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 день
}));

// Для обработки POST-запросов
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Отдаём статические файлы
app.use(express.static(__dirname));

// Функция генерации URL для входа через Steam
function steamAuthUrl(req) {
    const params = {
        'openid.ns': 'http://specs.openid.net/auth/2.0',
        'openid.mode': 'checkid_setup',
        'openid.return_to': 'http://localhost:3000/auth/steam/return',
        'openid.realm': 'http://localhost:3000',
        'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
        'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
    };
    const url = new URL('https://steamcommunity.com/openid/login');
    Object.keys(params).forEach(key => url.searchParams.set(key, params[key]));
    return url.toString();
}

// Функция проверки ответа Steam
async function verifySteamLogin(req) {
    const params = req.query;
    if (params['openid.mode'] !== 'id_res') return null;

    const checkParams = {
        'openid.assoc_handle': params['openid.assoc_handle'],
        'openid.signed': params['openid.signed'],
        'openid.sig': params['openid.sig'],
        'openid.ns': params['openid.ns']
    };

    const signed = params['openid.signed'].split(',');
    signed.forEach(field => {
        const key = 'openid.' + field;
        if (params[key]) {
            checkParams[key] = params[key];
        }
    });
    checkParams['openid.mode'] = 'check_authentication';

    const response = await fetch('https://steamcommunity.com/openid/login', {
        method: 'POST',
        body: new URLSearchParams(checkParams)
    });
    const text = await response.text();
    if (text.includes('is_valid:true')) {
        const claimedId = params['openid.claimed_id'];
        const steamId = claimedId.match(/\d+$/)[0];
        return steamId;
    }
    return null;
}

// API: получить инвентарь CS2 текущего пользователя
app.get('/api/inventory', async (req, res) => {
    try {
        const steamId = req.session.steamId;
        if (!steamId) {
            return res.status(401).json({ error: 'Необходимо войти' });
        }
        const url = `https://steamcommunity.com/inventory/${steamId}/730/2?l=russian&count=75`;
        const response = await fetch(url);
        if (!response.ok) {
            return res.status(response.status).json({ error: `Ошибка Steam: ${response.status}` });
        }
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// API: текущий пользователь
app.get('/api/user', (req, res) => {
    if (req.session.steamId) {
        const steamId = req.session.steamId;
        const row = db.prepare('SELECT apiKey FROM users WHERE steamId = ?').get(steamId);
        const hasApiKey = !!(row && row.apiKey);
        res.json({ steamId, hasApiKey });
    } else {
        res.json({ steamId: null });
    }
});

// API: получить профиль пользователя (ник и аватар)
app.get('/api/profile/:steamId', async (req, res) => {
    const steamId = req.params.steamId;
    if (!steamId) {
        return res.status(400).json({ error: 'Steam ID не указан' });
    }
    // Проверяем кэш (если свежий)
    const cached = profileCache[steamId];
    if (cached && (Date.now() - cached.updatedAt) < 24 * 60 * 60 * 1000) {
        return res.json({ steamId, nickname: cached.nickname, avatar: cached.avatar });
    }
    try {
        const profile = await fetchSteamProfile(steamId);
        profileCache[steamId] = { ...profile, updatedAt: Date.now() };
        res.json({ steamId, nickname: profile.nickname, avatar: profile.avatar });
    } catch (err) {
        console.error(`Ошибка получения профиля ${steamId}:`, err);
        res.status(500).json({ error: 'Не удалось получить профиль Steam' });
    }
});

// API: получить список объявлений
app.get('/api/offers', (req, res) => {
    const rows = db.prepare('SELECT * FROM offers ORDER BY createdAt DESC').all();
    const offers = rows.map(row => ({
        id: row.id,
        steamId: row.steamId,
        items: JSON.parse(row.items),
        want: row.want,
        createdAt: row.createdAt
    }));
    res.json({ offers });
});

// API: создать объявление
app.post('/api/offers', (req, res) => {
    if (!req.session.steamId) {
        return res.status(401).json({ error: 'Необходимо войти' });
    }
    const { items, want } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Не выбраны предметы' });
    }
    if (!want || !want.trim()) {
        return res.status(400).json({ error: 'Не указано описание желаемого' });
    }
    const validItems = items.every(item => item && item.classid && item.instanceid && item.name && item.icon_url);
    if (!validItems) {
        return res.status(400).json({ error: 'Некорректные данные о предметах' });
    }
    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
    const createdAt = new Date().toISOString();
    const itemsJson = JSON.stringify(items);
    db.prepare('INSERT INTO offers (id, steamId, items, want, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run(id, req.session.steamId, itemsJson, want.trim(), createdAt);
    const offer = { id, steamId: req.session.steamId, items, want: want.trim(), createdAt };
    res.status(201).json({ ok: true, offer });
});

// API: удалить объявление (только своё)
app.delete('/api/offers/:id', (req, res) => {
    if (!req.session.steamId) {
        return res.status(401).json({ error: 'Необходимо войти' });
    }
    const offerId = req.params.id;
    const row = db.prepare('SELECT steamId FROM offers WHERE id = ?').get(offerId);
    if (!row) {
        return res.status(404).json({ error: 'Объявление не найдено' });
    }
    if (row.steamId !== req.session.steamId) {
        return res.status(403).json({ error: 'Вы не можете удалить чужое объявление' });
    }
    db.prepare('DELETE FROM offers WHERE id = ?').run(offerId);
    res.json({ ok: true });
});

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Маршрут: отправляем пользователя на Steam
app.get('/auth/steam', (req, res) => {
    res.redirect(steamAuthUrl(req));
});

// Маршрут: Steam возвращает пользователя сюда
app.get('/auth/steam/return', async (req, res) => {
    try {
        const steamId = await verifySteamLogin(req);
        if (!steamId) {
            return res.status(403).send('Ошибка проверки Steam');
        }
        req.session.steamId = steamId;
        db.prepare('INSERT OR IGNORE INTO users (steamId) VALUES (?)').run(steamId);
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.status(500).send('Внутренняя ошибка сервера');
    }
});

// Маршрут: страница настроек (только для вошедших)
app.get('/settings', (req, res) => {
    if (!req.session.steamId) {
        return res.redirect('/auth/steam');
    }
    res.sendFile(path.join(__dirname, 'settings.html'));
});

// Обработка отправки ключа
app.post('/settings', (req, res) => {
    if (!req.session.steamId) {
        return res.status(401).send('Необходимо войти');
    }
    const steamId = req.session.steamId;
    const apiKey = req.body.apiKey && req.body.apiKey.trim();
    if (!apiKey) {
        return res.status(400).send('Ключ не указан');
    }
    db.prepare('INSERT INTO users (steamId, apiKey) VALUES (?, ?) ON CONFLICT(steamId) DO UPDATE SET apiKey = ?')
      .run(steamId, apiKey, apiKey);
    res.redirect('/settings?saved=1');
});

// Выход
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
    console.log('База данных: trade.db');
});