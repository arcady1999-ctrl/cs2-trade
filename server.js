const express = require('express');
const path = require('path');
const session = require('express-session');
const app = express();

// Настройка сессий
app.use(session({
    secret: 'мой_секретный_ключ_для_сессий',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 день
}));

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

// API: текущий пользователь
app.get('/api/user', (req, res) => {
    if (req.session.steamId) {
        res.json({ steamId: req.session.steamId });
    } else {
        res.json({ steamId: null });
    }
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
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.status(500).send('Внутренняя ошибка сервера');
    }
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
});