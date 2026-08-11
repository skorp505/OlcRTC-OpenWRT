'use strict';
'require view';
'require uci';
'require rpc';
'require ui';

/*
 * OlcRTC-OpenWRT — LuCI-панель управления
 * Основана на проекте OlcRTC (https://github.com/openlibrecommunity/olcrtc)
 * автора zarazaex / openlibrecommunity
 */

/* ══════════════════════════════════════════════════════════
   RPC-объявления
   ══════════════════════════════════════════════════════════ */

var callInitAction = rpc.declare({
    object : 'rc',
    method : 'init',
    params : [ 'name', 'action' ],
    expect : { result: 0 }
});

var callServiceList = rpc.declare({
    object : 'service',
    method : 'list',
    params : [ 'name' ],
    expect : { '': {} }
});

var callUciSet = rpc.declare({
    object : 'uci',
    method : 'set',
    params : [ 'config', 'section', 'values' ],
    expect : {}
});

var callUciCommit = rpc.declare({
    object : 'uci',
    method : 'commit',
    params : [ 'config' ],
    expect : {}
});

var callUciAdd = rpc.declare({
    object : 'uci',
    method : 'add',
    params : [ 'config', 'type' ],
    expect : { section: '' }
});

var callUciDelete = rpc.declare({
    object : 'uci',
    method : 'delete',
    params : [ 'config', 'section' ],
    expect : {}
});

var callExec = rpc.declare({
    object : 'file',
    method : 'exec',
    params : [ 'command', 'params', 'env' ],
    expect : { stdout: '' }
});

/* ══════════════════════════════════════════════════════════
   Провайдеры (carrier), транспорты и матрица совместимости
   2 = работает, 1 = нестабильно (~), 0 = не работает
   Источник: docs/settings.md актуального olcrtc
   Рекомендуемая комбинация: jitsi + datachannel
   ══════════════════════════════════════════════════════════ */

var CARRIERS   = ['jitsi', 'telemost', 'wbstream'];
var TRANSPORTS = ['datachannel', 'vp8channel', 'seichannel', 'videochannel'];

var COMPAT = {
    telemost : { datachannel: 0, vp8channel: 2, seichannel: 0, videochannel: 2 },
    wbstream : { datachannel: 1, vp8channel: 2, seichannel: 2, videochannel: 2 },
    jitsi    : { datachannel: 2, vp8channel: 1, seichannel: 1, videochannel: 1 },
    none     : { datachannel: 1, vp8channel: 1, seichannel: 1, videochannel: 1 }
};

var CARRIER_NAMES = { jitsi: 'Jitsi', telemost: 'Telemost', wbstream: 'WBStream', none: 'Engine' };
var TRANSPORT_LABELS = { datachannel: 'DataCh', vp8channel: 'VP8Ch', seichannel: 'SEICh', videochannel: 'VideoCh' };

function compatStatus(carrier, transport) {
    var m = COMPAT[carrier];
    return (m && m[transport] !== undefined) ? m[transport] : 0;
}

function statusIcon(status) {
    if (status === 2) return { ch: '✓', color: '#3fb950' };
    if (status === 1) return { ch: '~', color: '#d29922' };
    return { ch: '✗', color: '#f85149' };
}

/* ══════════════════════════════════════════════════════════
   Утилиты
   ══════════════════════════════════════════════════════════ */

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function fmtTime(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
function fmtDate(ts) {
    if (!ts) return '';
    var d = new Date(ts * 1000);
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() +
           ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* Длительность сессии «h:mm:ss» по миллисекундам */
function fmtDur(ms) {
    if (!isFinite(ms) || ms < 0) return '—';
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 3600) + ':' + pad2(Math.floor((s % 3600) / 60)) + ':' + pad2(s % 60);
}

/* Момент старта сессии из первой строки logread вида «Mon Aug 11 12:00:00 2026 olcrtc: ...» */
var SESSION_START = 0;
function parseLogStart(text) {
    var m = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})/.exec(text || '');
    if (!m) return 0;
    var MON = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
    if (!(m[1] in MON)) return 0;
    return new Date(+m[6], MON[m[1]], +m[2], +m[3], +m[4], +m[5]).getTime();
}

/* hex → rgba, например '#4A90E2', 0.08 → 'rgba(74,144,226,0.08)' */
function hexToRgba(hex, alpha) {
    if (!hex || hex.charAt(0) !== '#') return null;
    var h = hex.slice(1);
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    if (h.length !== 6) return null;
    var r = parseInt(h.slice(0,2), 16);
    var g = parseInt(h.slice(2,4), 16);
    var b = parseInt(h.slice(4,6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

/* ══════════════════════════════════════════════════════════
   Парсер параметров транспорта из URI (<key=val&key=val>)
   ══════════════════════════════════════════════════════════ */

function parseTransportParams(transport, paramsStr) {
    var result = {};
    if (!paramsStr) return result;
    paramsStr.split('&').forEach(function (pair) {
        var eq = pair.indexOf('=');
        if (eq < 0) return;
        var k = pair.slice(0, eq).trim();
        var v = pair.slice(eq + 1).trim();
        if (transport === 'seichannel') {
            if (k === 'fps')    result.sei_fps    = v;
            if (k === 'batch')  result.sei_batch  = v;
            if (k === 'frag')   result.sei_frag   = v;
            if (k === 'ack-ms') result.sei_ack_ms = v;
        } else if (transport === 'vp8channel') {
            if (k === 'vp8-fps')   result.vp8_fps   = v;
            if (k === 'vp8-batch') result.vp8_batch = v;
        } else if (transport === 'videochannel') {
            if (k === 'video-codec')       result.video_codec       = v;
            if (k === 'video-w')           result.video_w           = v;
            if (k === 'video-h')           result.video_h           = v;
            if (k === 'video-fps')         result.video_fps         = v;
            if (k === 'video-bitrate')     result.video_bitrate     = v;
            if (k === 'video-hw')          result.video_hw          = v;
            if (k === 'video-qr-recovery') result.video_qr_recovery = v;
            if (k === 'video-qr-size')     result.video_qr_size     = v;
            if (k === 'video-tile-module') result.video_tile_module = v;
            if (k === 'video-tile-rs')     result.video_tile_rs     = v;
        }
    });
    return result;
}

/* ══════════════════════════════════════════════════════════
   Парсер URI olcrtc://  (актуальный формат docs/uri.md)
   olcrtc://<Auth>?<Transport>[<key=val&...>]@<RoomID>#<Key>[$<MIMO>]
   Поддерживается legacy-вариант #Key%ClientId без $MIMO.
   ══════════════════════════════════════════════════════════ */

function parseOlcrtcUri(raw) {
    var uri = raw.trim();
    if (uri.indexOf('olcrtc://') !== 0) return null;
    var rest = uri.slice(9);
    var i;

    i = rest.indexOf('?');
    if (i < 1) return null;
    var carrier = rest.slice(0, i);
    rest = rest.slice(i + 1);

    var transport, transportParams = {};
    var ltIdx = rest.indexOf('<');
    var atIdx = rest.indexOf('@');

    if (ltIdx !== -1 && (atIdx === -1 || ltIdx < atIdx)) {
        transport = rest.slice(0, ltIdx);
        var gtIdx = rest.indexOf('>');
        if (gtIdx < 0) return null;
        transportParams = parseTransportParams(transport, rest.slice(ltIdx + 1, gtIdx));
        rest = rest.slice(gtIdx + 1);
        if (rest.charAt(0) !== '@') return null;
        rest = rest.slice(1);
    } else {
        i = rest.indexOf('@');
        if (i < 1) return null;
        transport = rest.slice(0, i);
        rest = rest.slice(i + 1);
    }

    i = rest.indexOf('#');
    if (i < 1) return null;
    var roomId = rest.slice(0, i);
    rest = rest.slice(i + 1);

    /* <Key> [$<MIMO>]  или legacy <Key>[%<ClientId>] */
    var dollar = rest.indexOf('$');
    var pct    = rest.indexOf('%');
    var sep    = dollar === -1 ? (pct === -1 ? -1 : pct) : dollar;
    var key    = sep === -1 ? rest : rest.slice(0, sep);
    var mimo   = dollar !== -1 ? rest.slice(dollar + 1) : '';

    if (CARRIERS.indexOf(carrier)     === -1) return null;
    if (TRANSPORTS.indexOf(transport) === -1) return null;
    if (key.length !== 64)                     return null;
    if (compatStatus(carrier, transport) === 0) return null;

    return {
        carrier: carrier, transport: transport,
        room_id: roomId, key: key,
        mimo: mimo, transportParams: transportParams
    };
}

/* ══════════════════════════════════════════════════════════
   Парсер формата подписки
   ══════════════════════════════════════════════════════════ */

function parseRefreshMs(str) {
    var num  = parseInt(str, 10);
    if (isNaN(num) || num <= 0) return 10 * 60 * 1000;
    var unit = str.replace(/[0-9]/g, '').trim().toLowerCase();
    if (unit === 's') return num * 1000;
    if (unit === 'h') return num * 3600 * 1000;
    if (unit === 'd') return num * 86400 * 1000;
    return num * 60 * 1000;
}

function refreshLabel(str) {
    var num  = parseInt(str, 10);
    var unit = str.replace(/[0-9]/g, '').trim().toLowerCase();
    var names = { s: 'сек', m: 'мин', h: 'ч', d: 'д' };
    return num + ' ' + (names[unit] || 'мин');
}

function parseSubscription(text) {
    var lines = text.split('\n');
    var sub = {
        name: '', update: 0, refresh: '10m', refreshMs: 10 * 60 * 1000,
        color: '', icon: '', used: '', available: '', servers: []
    };
    var cur = null;

    for (var li = 0; li < lines.length; li++) {
        var line = lines[li].trim();
        if (!line) continue;

        if (line.indexOf('##') === 0) {
            if (!cur) continue;
            var sep = line.indexOf(':', 2);
            if (sep < 0) continue;
            var k = line.slice(2, sep).trim();
            var v = line.slice(sep + 1).trim();
            if      (k === 'name')      cur.name      = v;
            else if (k === 'color')     cur.color     = v;
            else if (k === 'icon')      cur.icon      = v;
            else if (k === 'used')      cur.used      = v;
            else if (k === 'available') cur.available = v;
            else if (k === 'ip')        cur.ip        = v;
            else if (k === 'comment')   cur.comment   = v;
        } else if (line.indexOf('#') === 0) {
            var sep2 = line.indexOf(':', 1);
            if (sep2 < 0) continue;
            var gk = line.slice(1, sep2).trim();
            var gv = line.slice(sep2 + 1).trim();
            if      (gk === 'name')      sub.name       = gv;
            else if (gk === 'update')    sub.update     = parseInt(gv, 10) || 0;
            else if (gk === 'refresh') { sub.refresh = gv; sub.refreshMs = parseRefreshMs(gv); }
            else if (gk === 'color')     sub.color      = gv;
            else if (gk === 'icon')      sub.icon       = gv;
            else if (gk === 'used')      sub.used       = gv;
            else if (gk === 'available') sub.available  = gv;
        } else if (line.indexOf('olcrtc://') === 0) {
            var parsed = parseOlcrtcUri(line);
            if (!parsed) continue;
            cur = {
                uri: line, parsed: parsed,
                name: '', color: '', icon: '', used: '',
                available: '', ip: '', comment: ''
            };
            sub.servers.push(cur);
        }
    }

    return sub.servers.length > 0 ? sub : null;
}

/* ══════════════════════════════════════════════════════════
   Сервисные функции
   ══════════════════════════════════════════════════════════ */

function getStatus() {
    return callServiceList('olcrtc').then(function (res) {
        var inst = (res && res.olcrtc && res.olcrtc.instances) ? res.olcrtc.instances : {};
        var running = false, pid = null;
        Object.keys(inst).forEach(function (k) {
            if (inst[k].running) { running = true; pid = inst[k].pid || null; }
        });
        return { running: running, pid: pid };
    }).catch(function () { return { running: false, pid: null }; });
}

function getLogs() {
    return callExec('/sbin/logread', ['-e', 'olcrtc'], null)
        .then(function (res) {
            if (res && res.length > 0) {
                if (!SESSION_START) SESSION_START = parseLogStart(res);
                return res;
            }
            return '(записей в логе пока нет)';
        })
        .catch(function () {
            return callExec('/sbin/logread', [], null)
                .then(function (res) {
                    if (!res) return '(лог пуст)';
                    var lines = res.split('\n').filter(function (l) { return l.toLowerCase().indexOf('olcrtc') !== -1; });
                    return lines.length ? lines.join('\n') : '(записей с тегом olcrtc нет)';
                })
                .catch(function () { return '(logread недоступен — проверьте ACL)'; });
        });
}

/* ══════════════════════════════════════════════════════════
   Стиль выбранной карточки (зелёный, поверх цвета сервера)
   ══════════════════════════════════════════════════════════ */

var CARD_SELECTED_STYLE = 'cursor:pointer;border:1px solid #3fb950;border-radius:8px;' +
    'padding:10px 14px;background:rgba(63,185,80,0.12);flex:1 1 150px;min-width:130px;max-width:220px;' +
    'transition:border-color 0.15s,background 0.15s;user-select:none;';

/* ── Тёмно-фиолетовая тема ───────────────────────────────── */
var CARD_STYLE = 'background:linear-gradient(180deg,rgba(180,140,255,0.07) 0%,rgba(180,140,255,0.02) 100%);' +
                 'border:1px solid rgba(138,92,246,0.22);' +
                 'border-radius:12px;padding:18px 20px;height:100%;box-sizing:border-box;';
var CARD_HDR   = 'font-size:0.7em;text-transform:uppercase;letter-spacing:0.08em;color:#c9a8ff;' +
                 'margin-bottom:14px;padding-bottom:9px;font-weight:600;' +
                 'border-bottom:1px solid rgba(138,92,246,0.18);';
var HR_STYLE   = 'border:none;border-top:1px solid rgba(138,92,246,0.12);margin:10px 0;';

var OLCRTC_STYLE =
    /* Тема: токены + переключение на «синюю» (LuCI) */
    '.olcrtc-theme{--olcrtc-accent:#8a5cf6;--olcrtc-accent2:#c084fc;}' +
    '.olcrtc-theme.luci{--olcrtc-accent:#3b82f6;--olcrtc-accent2:#60a5fa;}' +
    /* Появление карточек */
    '@keyframes olcrtcFadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}' +
    '.olcrtc-card{transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease;' +
        'animation:olcrtcFadeUp .45s ease both;}' +
    '.olcrtc-card:hover{border-color:rgba(196,160,255,0.5)!important;' +
        'box-shadow:0 8px 28px rgba(138,92,246,0.22);transform:translateY(-1px);}' +
    '.olcrtc-hdr{display:flex;align-items:center;gap:9px;}' +
    '.olcrtc-hdr svg{display:block;flex:0 0 auto;}' +
    '@keyframes olcrtcPulse{0%{box-shadow:0 0 0 0 rgba(63,185,80,0.5)}' +
        '70%{box-shadow:0 0 0 7px rgba(63,185,80,0)}' +
        '100%{box-shadow:0 0 0 0 rgba(63,185,80,0)}}' +
    '.olcrtc-subhead{font-size:0.72em;text-transform:uppercase;letter-spacing:0.06em;' +
        'color:#7a5f99;margin:14px 0 8px;padding-bottom:4px;' +
        'border-bottom:1px dashed rgba(138,92,246,0.14);}' +
    /* Бейдж статуса */
    '.olcrtc-badge{display:inline-flex;align-items:center;gap:7px;padding:5px 14px;border-radius:999px;' +
        'font-size:0.85em;font-weight:600;line-height:1.4;white-space:nowrap;}' +
    '.olcrtc-badge::before{content:"";width:8px;height:8px;border-radius:50%;}' +
    '.olcrtc-badge.on{background:rgba(63,185,80,0.14);color:#3fb950;border:1px solid rgba(63,185,80,0.4);}' +
    '.olcrtc-badge.on::before{background:#3fb950;animation:olcrtcPulse 2s infinite;}' +
    '.olcrtc-badge.off{background:rgba(248,81,73,0.12);color:#f85149;border:1px solid rgba(248,81,73,0.4);}' +
    '.olcrtc-badge.off::before{background:#f85149;box-shadow:0 0 6px rgba(248,81,73,0.6);}' +
    '.olcrtc-statusmeta{font-size:0.78em;color:#8b949e;}' +
    /* Тост */
    '.olcrtc-toast{position:fixed;right:24px;bottom:24px;z-index:1000;padding:12px 18px;border-radius:10px;' +
        'background:linear-gradient(135deg,#7c3aed,#8a5cf6);color:#fff;font-size:0.85em;' +
        'box-shadow:0 10px 30px rgba(0,0,0,0.45);opacity:0;transform:translateY(10px);' +
        'transition:opacity .25s,transform .25s;pointer-events:none;' +
        'border:1px solid rgba(255,255,255,0.18);' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}' +
    /* Адаптив под мобильные */
    '@media (max-width:980px){' +
        '.olcrtc-row{flex-direction:column!important;}' +
        '.olcrtc-col{flex:1 1 auto!important;}' +
        '.olcrtc-frow{flex-direction:column!important;}' +
        '.olcrtc-frow>label{flex:0 0 auto!important;padding-top:0!important;}' +
        '.olcrtc-toast{right:12px;left:12px;bottom:12px;text-align:center;}' +
    '}' +
    /* Тема LuCI: переопределения */
    '.olcrtc-theme.luci{background:linear-gradient(160deg,#0c1526 0%,#081c33 100%)!important;}' +
    '.olcrtc-theme.luci .olcrtc-card{background:linear-gradient(180deg,rgba(59,130,246,0.07) 0%,rgba(59,130,246,0.02) 100%)!important;' +
        'border-color:rgba(59,130,246,0.28)!important;}' +
    '.olcrtc-theme.luci .olcrtc-card:hover{border-color:rgba(96,165,250,0.6)!important;' +
        'box-shadow:0 8px 28px rgba(37,99,235,0.25)!important;}' +
    '.olcrtc-theme.luci .olcrtc-hdr{color:#93c5fd!important;border-bottom-color:rgba(59,130,246,0.22)!important;}' +
    '.olcrtc-theme.luci .olcrtc-subhead{color:#7aa7e0!important;border-bottom-color:rgba(59,130,246,0.16)!important;}' +
    '.olcrtc-theme.luci .olcrtc-title{color:#e6edf3!important;}' +
    '.olcrtc-theme.luci .olcrtc-under{background:linear-gradient(90deg,#3b82f6,#60a5fa)!important;}';

/* Иконки заголовков карточек (инлайновый SVG, цвет через CSS-переменную темы) */
var _OLCRTC_ICON = function (inner) {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" ' +
        'style="color:var(--olcrtc-accent,#8a5cf6);vertical-align:-2px">' + inner + '</svg>';
};
var ICON_STATUS  = _OLCRTC_ICON('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>');
var ICON_URI     = _OLCRTC_ICON('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>');
var ICON_COMPAT  = _OLCRTC_ICON('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>');
var ICON_SETTINGS = _OLCRTC_ICON('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>');
var ICON_SOCKS   = _OLCRTC_ICON('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>');
var ICON_TRANSPORT = _OLCRTC_ICON('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>');
var ICON_RELIABILITY = _OLCRTC_ICON('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>');
var ICON_EXTRA   = _OLCRTC_ICON('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>');

var _cardIconCounter = 0;
var CARD_ICONS = {
    'Статус': ICON_STATUS,
    'Подключение по URI / Профили': ICON_URI,
    'Совместимость': ICON_COMPAT,
    'Базовые настройки подключения': ICON_SETTINGS,
    'SOCKS5 прокси': ICON_SOCKS,
    'Параметры транспорта': ICON_TRANSPORT,
    'Надёжность и лимиты (опционально)': ICON_RELIABILITY,
    'Дополнительно': ICON_EXTRA
};
function card(title, nodes, iconSvgMarkup) {
    var inner = Array.isArray(nodes) ? nodes : [nodes];
    var hdrChildren = [];
    var svg = iconSvgMarkup || CARD_ICONS[title];
    if (svg) {
        var iconEl = E('span', { style: 'display:inline-flex;flex:0 0 auto;line-height:0;opacity:0.92;' });
        iconEl.innerHTML = svg;
        hdrChildren.push(iconEl);
    }
    if (title) hdrChildren.push(E('span', {}, title));
    var el = E('div', { class: 'olcrtc-card', style: CARD_STYLE },
        (hdrChildren.length ? [E('div', { class: 'olcrtc-hdr', style: CARD_HDR }, hdrChildren)] : []).concat(inner)
    );
    el.style.animationDelay = ((_cardIconCounter++) % 12) * 0.05 + 's';
    return el;
}

/* ══════════════════════════════════════════════════════════
   Основной вид
   ══════════════════════════════════════════════════════════ */

return view.extend({

    _hwid                : null,
    _statusTimer         : null,
    _logsTimer           : null,
    _badgeEl             : null,
    _statusMetaEl        : null,
    _logsEl              : null,
    _startBtn            : null,
    _stopBtn             : null,
    _transportSel        : null,
    _carrierSel          : null,
    _roomInput           : null,
    _keyInput            : null,
    _vp8Section          : null,
    _seiSection          : null,
    _videoSection        : null,
    _engineSection       : null,
    _datachannelHint     : null,
    _qrRows              : null,
    _tileRows            : null,
    _transportParamInputs: null,
    _uriLabel            : null,
    _uriInput            : null,
    _subsContainer       : null,
    _subscriptions       : null,   /* [{sectionName, url, blockEl, timer}] */
    _profiles            : null,   /* [{sectionName, uri, parsed, name, nameShort, card, normalStyle}] */
    _profilesContainer   : null,
    _activeProfileLabel  : null,
    _selectedServer      : null,   /* {data, card, normalStyle, values} */
    _updateMatrix        : null,

    load: function () {
        return Promise.all([ uci.load('olcrtc'), getStatus() ]);
    },

    /* Загрузка подписки с правильными заголовками */
    _fetchSub: function (url) {
        var hwid = this._hwid || '';
        var args = ['-q', '-O', '-', '--timeout=15',
                    '-U', 'olcrtc-openwrt'];
        if (hwid) args.push('--header=X-HWID: ' + hwid);
        args.push('--header=Accept-Encoding: gzip');
        args.push(url);
        return callExec('/usr/bin/wget', args, null)
            .then(function (res) { return res || ''; });
    },

    _saveField: function (key, value) {
        var self = this;
        var vals = {};
        vals[key] = value;
        callUciSet('olcrtc', 'config', vals)
            .then(function () { return callUciCommit('olcrtc'); })
            .then(function () { self._toast('Настройки сохранены'); })
            .catch(function (e) { console.error('[OlcRTC] UCI error:', e); });
    },

    _updateUI: function (status) {
        if (this._badgeEl) {
            this._badgeEl.className = 'olcrtc-badge ' + (status.running ? 'on' : 'off');
            this._badgeEl.textContent = status.running ? 'Работает' : 'Остановлен';
        }
        if (this._statusMetaEl) {
            var meta = [];
            if (status.running) {
                if (status.pid) meta.push('PID ' + status.pid);
                if (SESSION_START) meta.push('сессия ' + fmtDur(Date.now() - SESSION_START));
            } else {
                meta.push('клиент не запущен');
            }
            this._statusMetaEl.textContent = meta.join(' · ');
        }
        if (this._startBtn) {
            this._startBtn.disabled      = !!status.running;
            this._startBtn.style.opacity = status.running ? '0.5' : '1';
        }
        if (this._stopBtn) {
            this._stopBtn.disabled       = !status.running;
            this._stopBtn.style.opacity  = !status.running ? '0.5' : '1';
        }
    },

    _startPolling: function () {
        var self = this;
        if (self._statusTimer) clearInterval(self._statusTimer);
        self._statusTimer = setInterval(function () {
            getStatus().then(function (s) { self._updateUI(s); });
        }, 300);

        if (self._logsTimer) clearInterval(self._logsTimer);
        self._logsTimer = setInterval(function () {
            getLogs().then(function (text) {
                if (!self._logsEl) return;
                var el = self._logsEl;
                var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                el.textContent = text;
                if (atBottom) el.scrollTop = el.scrollHeight;
            });
        }, 3000);
    },

    _updateTransportSections: function (transport) {
        if (this._vp8Section)      this._vp8Section.style.display      = transport === 'vp8channel'   ? '' : 'none';
        if (this._seiSection)      this._seiSection.style.display      = transport === 'seichannel'   ? '' : 'none';
        if (this._videoSection)    this._videoSection.style.display    = transport === 'videochannel' ? '' : 'none';
        if (this._datachannelHint) this._datachannelHint.style.display = transport === 'datachannel'  ? '' : 'none';
    },

    _updateCarrierSections: function (carrier) {
        if (this._engineSection) this._engineSection.style.display = carrier === 'none' ? '' : 'none';
    },

    _updateTransportOptions: function (carrier) {
        var sel = this._transportSel;
        if (!sel) return;
        var allowed = TRANSPORTS.filter(function (t) { return compatStatus(carrier, t) > 0; });
        for (var i = 0; i < sel.options.length; i++)
            sel.options[i].disabled = allowed.indexOf(sel.options[i].value) === -1;
        if (allowed.indexOf(sel.value) === -1) {
            sel.value = allowed.length ? allowed[0] : 'vp8channel';
            this._saveField('transport', sel.value);
        }
        this._updateTransportSections(sel.value);
    },

    _updateVideoCodecRows: function (codec) {
        if (this._qrRows)   this._qrRows.forEach(function (el)  { el.style.display = codec === 'qrcode' ? '' : 'none'; });
        if (this._tileRows) this._tileRows.forEach(function (el) { el.style.display = codec === 'tile'   ? '' : 'none'; });
    },

    /* ── Выбранный сервер ─────────────────────────────────── */

    _checkServerSelection: function (field, value) {
        if (!this._selectedServer) return;
        if (this._selectedServer.values[field] === value) return;
        this._selectedServer.card.style.cssText = this._selectedServer.normalStyle;
        this._selectedServer = null;
    },

    _applyServer: function (server, cardEl, normalStyle) {
        var self = this;
        var p    = server.parsed;

        if (self._selectedServer) self._selectedServer.card.style.cssText = self._selectedServer.normalStyle;

        self._applyParsed(p);
        self._refreshActiveProfile();

        self._selectedServer = {
            data       : server,
            card       : cardEl,
            normalStyle: normalStyle,
            values     : { carrier: p.carrier, transport: p.transport,
                           room_id: p.room_id, key: p.key }
        };
        cardEl.style.cssText = CARD_SELECTED_STYLE;
    },

    /* Применить разобранный URI к конфигурации (общий для подписок и профилей) */
    _applyParsed: function (p) {
        var self = this;

        if (self._carrierSel)   self._carrierSel.value   = p.carrier;
        if (self._transportSel) self._transportSel.value = p.transport;
        if (self._roomInput)    self._roomInput.value    = p.room_id;
        if (self._keyInput)     self._keyInput.value     = p.key;

        self._updateTransportOptions(p.carrier);
        if (self._updateMatrix) self._updateMatrix(p.carrier, p.transport);
        self._updateCarrierSections(p.carrier);

        var tp = p.transportParams || {};
        var uciVals = {
            carrier: p.carrier, transport: p.transport,
            room_id: p.room_id, key: p.key
        };
        Object.keys(tp).forEach(function (k) {
            uciVals[k] = tp[k];
            if (self._transportParamInputs && self._transportParamInputs[k]) {
                var el = self._transportParamInputs[k];
                el.value = tp[k];
                if (k === 'video_codec') self._updateVideoCodecRows(tp[k]);
            }
        });

        callUciSet('olcrtc', 'config', uciVals)
            .then(function () { return callUciCommit('olcrtc'); })
            .then(function () { self._toast('Настройки применены'); })
            .catch(function (e) { console.error('[OlcRTC] apply error:', e); });
    },

    /* ── Профили (olcrtc:// ссылки) ───────────────────────── */

    _createProfileEntry: function (sectionName, uri) {
        var self = this;
        var p = parseOlcrtcUri(uri);
        if (!p) return null;

        var name = (p.mimo || '').trim().replace(/\s+/g, ' ') ||
                   (CARRIER_NAMES[p.carrier] || p.carrier) + ' ' + (TRANSPORT_LABELS[p.transport] || p.transport);
        var nameShort = name.length > 26 ? name.slice(0, 26).trim() + '…' : name;

        var delBtn = E('button', {
            class : 'btn cbi-button cbi-button-remove',
            style : 'font-size:0.72em;padding:1px 7px;white-space:nowrap;flex:0 0 auto;',
            click : function (ev) {
                ev.stopPropagation();
                self._removeProfile(sectionName);
            }
        }, '✕');

        var cardEl = E('div', {}, [
            E('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:4px;' }, [
                E('div', { style: 'font-size:0.95em;color:#e6edf3;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, nameShort),
                delBtn
            ]),
            E('div', { style: 'font-size:0.78em;color:#8b949e;' },
                (CARRIER_NAMES[p.carrier] || p.carrier) + ' / ' + (TRANSPORT_LABELS[p.transport] || p.transport)),
            E('div', { style: 'font-size:0.72em;color:#7a5f99;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;' }, p.room_id)
        ]);

        var normalStyle = 'cursor:pointer;border:1px solid rgba(138,92,246,0.28);border-radius:8px;' +
                          'padding:10px 12px;background:rgba(138,92,246,0.06);flex:1 1 150px;' +
                          'min-width:140px;max-width:230px;' +
                          'transition:border-color 0.15s,background 0.15s;user-select:none;';
        cardEl.style.cssText = normalStyle;

        var entry = {
            sectionName: sectionName, uri: uri, parsed: p,
            name: name, nameShort: nameShort,
            card: cardEl, normalStyle: normalStyle
        };
        self._profiles.push(entry);

        cardEl.addEventListener('click', function () { self._applyProfile(entry); });

        if (self._profilesContainer) self._profilesContainer.appendChild(cardEl);
        return entry;
    },

    /* Активировать профиль: применить параметры и, при подтверждении, перезапустить сервис */
    _applyProfile: function (entry) {
        var self = this;

        self._applyParsed(entry.parsed);
        self._refreshActiveProfile();

        getStatus().then(function (s) {
            if (!s.running) {
                ui.addNotification(null, E('p', 'Профиль «' + entry.name + '» применён. Запустите сервис.'),
                    'info');
                return;
            }

            ui.showModal('Перезапустить сервис?', [
                E('p', 'Профиль «' + entry.name + '» применён.'),
                E('p', 'Сервис OlcRTC сейчас запущен. Перезапустить его с новыми параметрами?'),
                E('div', { style: 'text-align:right;margin-top:12px;' }, [
                    E('button', {
                        class : 'btn cbi-button-reset',
                        style : 'margin-right:6px;',
                        click : function () {
                            ui.hideModal();
                            ui.addNotification(null, E('p', 'Параметры профиля «' + entry.name + '» применены. Перезапустите сервис вручную.'), 'info');
                        }
                    }, 'Позже'),
                    E('button', {
                        class : 'btn cbi-button-apply',
                        click : function () {
                            ui.hideModal();
                            return callInitAction('olcrtc', 'restart')
                                .then(function () {
                                    ui.addNotification(null, E('p', 'Профиль «' + entry.name + '» применён, сервис перезапущен.'), 'info');
                                })
                                .catch(function (e) {
                                    ui.addNotification(null, E('p', 'Профиль применён, но не удалось перезапустить: ' + (e.message || e)), 'error');
                                });
                        }
                    }, 'Перезапустить')
                ])
            ]);
        });
    },

    /* Подсветить активный профиль (совпадает с текущими полями) */
    _refreshActiveProfile: function () {
        var self = this;
        var cur = {
            carrier  : self._carrierSel ? self._carrierSel.value   : '',
            transport: self._transportSel ? self._transportSel.value : '',
            room_id  : self._roomInput ? self._roomInput.value : '',
            key      : self._keyInput ? self._keyInput.value : ''
        };
        var active = null;
        (self._profiles || []).forEach(function (e) {
            var p = e.parsed;
            var match = p.carrier === cur.carrier && p.transport === cur.transport &&
                        p.room_id === cur.room_id && p.key === cur.key;
            e.card.style.cssText = match ? CARD_SELECTED_STYLE : e.normalStyle;
            if (match) active = e;
        });
        if (self._activeProfileLabel)
            self._activeProfileLabel.textContent = active ? 'Профиль: «' + active.name + '»' : 'Профиль: не выбран';
    },

    /* Удалить профиль */
    _removeProfile: function (sectionName) {
        var self = this;
        if (!self._profiles) return;

        for (var i = 0; i < self._profiles.length; i++) {
            var e = self._profiles[i];
            if (e.sectionName !== sectionName) continue;
            if (e.card && e.card.parentNode) e.card.parentNode.removeChild(e.card);
            self._profiles.splice(i, 1);
            break;
        }

        callUciDelete('olcrtc', sectionName)
            .then(function () { return callUciCommit('olcrtc'); })
            .catch(function (err) { console.error('[OlcRTC] delete profile error:', err); });

        self._refreshActiveProfile();
    },

    /* ══════════════════════════════════════════════════════════
       Управление подписками
       ══════════════════════════════════════════════════════════ */

    /* Заполнить содержимое блока подписки */
    _fillSubBlock: function (blockEl, entry, sub) {
        var self = this;

        /* Если в блоке была выбранная карточка — сбрасываем */
        if (self._selectedServer && blockEl.contains(self._selectedServer.card))
            self._selectedServer = null;

        blockEl.innerHTML = '';

        /* Применить цвет подписки к фону блока */
        var subBg     = sub.color ? hexToRgba(sub.color, 0.05) : '';
        var subBorder = sub.color ? hexToRgba(sub.color, 0.3)  : 'rgba(138,92,246,0.18)';
        blockEl.style.background   = subBg || '';
        blockEl.style.borderColor  = subBorder;

        /* Заголовок */
        var title = (sub.icon ? sub.icon + ' ' : '') + (sub.name || 'Подписка');
        var stats = (sub.used ? sub.used : '') + (sub.available ? ' / ' + sub.available : '');
        var refreshInfo = '↻ каждые ' + refreshLabel(sub.refresh);

        var deleteBtn = E('button', {
            class : 'btn cbi-button cbi-button-remove',
            style : 'font-size:0.78em;padding:3px 10px;white-space:nowrap;',
            click : function () { self._removeSubscription(entry.sectionName); }
        }, 'Удалить подписку');

        var headerRow = E('div', {
            style: 'display:flex;justify-content:space-between;align-items:flex-start;' +
                   'flex-wrap:wrap;gap:8px;margin-bottom:6px;'
        }, [
            E('div', {}, [
                E('div', { style: 'font-size:1em;color:#e6edf3;font-weight:500;' },
                    title + (stats ? ' ' + stats : '')),
                E('div', { style: 'font-size:0.8em;color:#8b949e;margin-top:2px;' }, refreshInfo)
            ]),
            deleteBtn
        ]);
        blockEl.appendChild(headerRow);

        if (sub.update) {
            blockEl.appendChild(E('div', {
                style: 'font-size:0.75em;color:#8b949e;margin-bottom:10px;'
            }, 'Данные от: ' + fmtDate(sub.update)));
        } else {
            blockEl.appendChild(E('div', { style: 'margin-bottom:10px;' }));
        }

        /* Карточки серверов */
        var cardsWrap = E('div', { style: 'display:flex;flex-wrap:wrap;gap:10px;' });

        sub.servers.forEach(function (server, idx) {
            var p    = server.parsed;
            var name = server.name ||
                       (p.mimo ? p.mimo.split('/')[0].trim() : 'Сервер ' + (idx + 1));

            /* Цвет карточки */
            var cardBg     = server.color ? hexToRgba(server.color, 0.07) : 'rgba(138,92,246,0.06)';
            var cardBorder = server.color ? hexToRgba(server.color, 0.35) : 'rgba(138,92,246,0.2)';
            var normalStyle = 'cursor:pointer;border:1px solid ' + cardBorder + ';border-radius:8px;' +
                              'padding:10px 14px;background:' + cardBg + ';flex:1 1 150px;' +
                              'min-width:130px;max-width:220px;' +
                              'transition:border-color 0.15s,background 0.15s;user-select:none;';

            var lines = [
                E('div', { style: 'font-size:0.95em;color:#e6edf3;font-weight:500;margin-bottom:4px;' +
                                  'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' },
                    (server.icon ? server.icon + ' ' : '') + name),
                E('div', { style: 'font-size:0.78em;color:#8b949e;' },
                    p.carrier + ' / ' + p.transport)
            ];
            if (server.ip)      lines.push(E('div', { style: 'font-size:0.78em;color:#8b949e;font-family:monospace;' }, server.ip));
            if (server.comment) lines.push(E('div', { style: 'font-size:0.78em;color:#8b949e;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, server.comment));
            if (server.used || server.available)
                lines.push(E('div', { style: 'font-size:0.75em;color:#8b949e;margin-top:4px;' },
                    (server.used || '') + (server.available ? ' / ' + server.available : '')));

            var card = E('div', { style: normalStyle }, lines);

            /* Восстановить подсветку после обновления если это тот же объект */
            if (self._selectedServer && self._selectedServer.data === server) {
                self._selectedServer.card       = card;
                self._selectedServer.normalStyle = normalStyle;
                card.style.cssText = CARD_SELECTED_STYLE;
            }

            card.addEventListener('click', function () { self._applyServer(server, card, normalStyle); });
            cardsWrap.appendChild(card);
        });

        blockEl.appendChild(cardsWrap);
    },

    /* Создать блок подписки (fetches URL, если sub не передан) */
    _createSubBlock: function (sectionName, url, subInitial) {
        var self = this;

        var blockEl = E('div', {
            style: 'border:1px solid rgba(138,92,246,0.18);border-radius:8px;padding:14px;margin-bottom:12px;'
        }, [E('div', { style: 'color:#9a7fc0;font-size:0.9em;' }, '⌛ Загрузка подписки...')]);

        var entry = { sectionName: sectionName, url: url, blockEl: blockEl, timer: null };
        if (!self._subscriptions) self._subscriptions = [];
        self._subscriptions.push(entry);

        if (self._subsContainer) self._subsContainer.appendChild(blockEl);

        function applyAndSchedule(sub) {
            self._fillSubBlock(blockEl, entry, sub);
            if (entry.timer) clearInterval(entry.timer);
            if (sub.refreshMs > 0) {
                entry.timer = setInterval(function () {
                    self._fetchSub(url)
                        .then(function (c) {
                            if (!c) return;
                            var updated = parseSubscription(c);
                            if (updated) applyAndSchedule(updated);
                        });
                }, sub.refreshMs);
            }
        }

        if (subInitial) {
            applyAndSchedule(subInitial);
        } else {
            self._fetchSub(url)
                .then(function (content) {
                    if (!content) return Promise.reject(new Error('empty'));
                    var sub = parseSubscription(content);
                    if (!sub) return Promise.reject(new Error('invalid'));
                    applyAndSchedule(sub);
                })
                .catch(function () {
                    blockEl.innerHTML = '';
                    var delBtn = E('button', {
                        class : 'btn cbi-button cbi-button-remove',
                        style : 'font-size:0.78em;padding:3px 10px;margin-left:10px;',
                        click : function () { self._removeSubscription(sectionName); }
                    }, 'Удалить');
                    blockEl.appendChild(E('div', {
                        style: 'display:flex;align-items:center;gap:8px;color:#f85149;font-size:0.85em;'
                    }, [
                        E('span', {}, '✗ Не удалось загрузить: ' + url),
                        delBtn
                    ]));
                });
        }
    },

    /* Добавить подписку по URL (из поля ввода) */
    _addSubscription: function (url) {
        var self = this;

        if (self._uriLabel) {
            self._uriLabel.textContent = '⌛ Загрузка подписки...';
            self._uriLabel.style.color = '#8b949e';
        }
        if (self._uriInput) self._uriInput.style.outline = '';

        return self._fetchSub(url)
            .then(function (content) {
                if (!content) return Promise.reject(new Error('empty'));
                var sub = parseSubscription(content);
                if (!sub) return Promise.reject(new Error('invalid'));

                return callUciAdd('olcrtc', 'subscription')
                    .then(function (sectionName) {
                        return callUciSet('olcrtc', sectionName, { url: url })
                            .then(function () { return callUciCommit('olcrtc'); })
                            .then(function () {
                                self._createSubBlock(sectionName, url, sub);

                                if (self._uriLabel) {
                                    self._uriLabel.textContent = '✓ Подписка добавлена!';
                                    self._uriLabel.style.color = '#3fb950';
                                }
                                if (self._uriInput) {
                                    self._uriInput.style.outline = '2px solid #3fb950';
                                    self._uriInput.value = '';
                                    setTimeout(function () {
                                        if (self._uriInput) self._uriInput.style.outline = '';
                                        if (self._uriLabel) self._uriLabel.textContent = '';
                                    }, 2500);
                                }
                            });
                    });
            })
            .catch(function () {
                if (self._uriLabel) {
                    self._uriLabel.textContent = '✗ Невалидная ссылка на подписку';
                    self._uriLabel.style.color = '#f85149';
                }
                if (self._uriInput) self._uriInput.style.outline = '2px solid #f85149';
            });
    },

    /* Удалить подписку */
    _removeSubscription: function (sectionName) {
        var self = this;
        if (!self._subscriptions) return;

        for (var i = 0; i < self._subscriptions.length; i++) {
            var entry = self._subscriptions[i];
            if (entry.sectionName !== sectionName) continue;

            if (entry.timer) clearInterval(entry.timer);
            if (entry.blockEl && entry.blockEl.parentNode)
                entry.blockEl.parentNode.removeChild(entry.blockEl);

            /* Сбросить выбранный сервер если он был из этого блока */
            if (self._selectedServer && !document.body.contains(self._selectedServer.card))
                self._selectedServer = null;

            self._subscriptions.splice(i, 1);
            break;
        }

        callUciDelete('olcrtc', sectionName)
            .then(function () { return callUciCommit('olcrtc'); })
            .catch(function (e) { console.error('[OlcRTC] delete sub error:', e); });
    },

    /* ══════════════════════════════════════════════════════════
       render()
       ══════════════════════════════════════════════════════════ */

    render: function (data) {
        var self       = this;
        var initStatus = data[1];

        self._subscriptions = [];
        self._profiles      = [];
        self._hwid = uci.get('olcrtc', 'config', 'hwid') || '';

        var cfg = {
            carrier          : uci.get('olcrtc', 'config', 'carrier')           || 'jitsi',
            transport        : uci.get('olcrtc', 'config', 'transport')         || 'datachannel',
            room_id          : uci.get('olcrtc', 'config', 'room_id')           || '',
            key              : uci.get('olcrtc', 'config', 'key')               || '',
            auth_token       : uci.get('olcrtc', 'config', 'auth_token')        || '',
            room_channel     : uci.get('olcrtc', 'config', 'room_channel')      || '',
            socks_host       : uci.get('olcrtc', 'config', 'socks_host')       || '127.0.0.1',
            socks_port       : uci.get('olcrtc', 'config', 'socks_port')       || '1080',
            socks_user       : uci.get('olcrtc', 'config', 'socks_user')       || '',
            socks_pass       : uci.get('olcrtc', 'config', 'socks_pass')       || '',
            socks_proxy_addr : uci.get('olcrtc', 'config', 'socks_proxy_addr') || '',
            socks_proxy_port : uci.get('olcrtc', 'config', 'socks_proxy_port') || '0',
            socks_proxy_user : uci.get('olcrtc', 'config', 'socks_proxy_user') || '',
            socks_proxy_pass : uci.get('olcrtc', 'config', 'socks_proxy_pass') || '',
            engine_name      : uci.get('olcrtc', 'config', 'engine_name')      || 'livekit',
            engine_url       : uci.get('olcrtc', 'config', 'engine_url')       || '',
            engine_token     : uci.get('olcrtc', 'config', 'engine_token')     || '',
            dns              : uci.get('olcrtc', 'config', 'dns')               || '1.1.1.1:53',
            debug            : uci.get('olcrtc', 'config', 'debug')             || '0',
            vp8_fps          : uci.get('olcrtc', 'config', 'vp8_fps')           || '30',
            vp8_batch        : uci.get('olcrtc', 'config', 'vp8_batch')         || '64',
            sei_fps          : uci.get('olcrtc', 'config', 'sei_fps')           || '30',
            sei_batch        : uci.get('olcrtc', 'config', 'sei_batch')         || '64',
            sei_frag         : uci.get('olcrtc', 'config', 'sei_frag')          || '900',
            sei_ack_ms       : uci.get('olcrtc', 'config', 'sei_ack_ms')        || '2000',
            video_codec      : uci.get('olcrtc', 'config', 'video_codec')       || 'qrcode',
            video_w          : uci.get('olcrtc', 'config', 'video_w')           || '1080',
            video_h          : uci.get('olcrtc', 'config', 'video_h')           || '1080',
            video_fps        : uci.get('olcrtc', 'config', 'video_fps')         || '30',
            video_bitrate    : uci.get('olcrtc', 'config', 'video_bitrate')     || '2M',
            video_hw         : uci.get('olcrtc', 'config', 'video_hw')          || 'none',
            video_qr_recovery: uci.get('olcrtc', 'config', 'video_qr_recovery') || 'low',
            video_qr_size    : uci.get('olcrtc', 'config', 'video_qr_size')     || '0',
            video_tile_module: uci.get('olcrtc', 'config', 'video_tile_module') || '4',
            video_tile_rs    : uci.get('olcrtc', 'config', 'video_tile_rs')     || '20',
            liveness_interval: uci.get('olcrtc', 'config', 'liveness_interval') || '10s',
            liveness_timeout : uci.get('olcrtc', 'config', 'liveness_timeout')  || '5s',
            liveness_failures: uci.get('olcrtc', 'config', 'liveness_failures') || '3',
            lifecycle_max_session_duration : uci.get('olcrtc', 'config', 'lifecycle_max_session_duration') || '',
            traffic_max_payload_size : uci.get('olcrtc', 'config', 'traffic_max_payload_size') || '0',
            traffic_min_delay : uci.get('olcrtc', 'config', 'traffic_min_delay') || '',
            traffic_max_delay : uci.get('olcrtc', 'config', 'traffic_max_delay') || ''
        };

        /* ── Статус ─────────────────────────────────────────── */
        var badgeEl = E('span', { class: 'olcrtc-badge off' }, 'Остановлен');
        self._badgeEl = badgeEl;

        var statusMetaEl = E('span', { class: 'olcrtc-statusmeta' });
        self._statusMetaEl = statusMetaEl;

        var startBtn = E('button', {
            class : 'btn cbi-button cbi-button-apply',
            style : 'margin-right:8px',
            click : ui.createHandlerFn(self, function () {
                startBtn.disabled = stopBtn.disabled = true;
                startBtn.style.opacity = stopBtn.style.opacity = '0.5';
                return callInitAction('olcrtc', 'start')
                    .then(function () {
                        self._toast('Клиент запущен');
                        ui.addNotification(null, E('p', 'OlcRTC запущен'), 'info');
                    })
                    .catch(function (e) { ui.addNotification(null, E('p', 'Ошибка запуска: ' + (e.message || e)), 'error'); })
                    .then(function () { return getStatus().then(function (s) { self._updateUI(s); }); });
            })
        }, '▶ Старт');

        var stopBtn = E('button', {
            class : 'btn cbi-button cbi-button-reset',
            click : ui.createHandlerFn(self, function () {
                startBtn.disabled = stopBtn.disabled = true;
                startBtn.style.opacity = stopBtn.style.opacity = '0.5';
                return callInitAction('olcrtc', 'stop')
                    .then(function () {
                        self._toast('Клиент остановлен');
                        ui.addNotification(null, E('p', 'OlcRTC остановлен'), 'info');
                    })
                    .catch(function (e) { ui.addNotification(null, E('p', 'Ошибка остановки: ' + (e.message || e)), 'error'); })
                    .then(function () { return getStatus().then(function (s) { self._updateUI(s); }); });
            })
        }, '■ Стоп');

        self._startBtn = startBtn;
        self._stopBtn  = stopBtn;
        self._updateUI(initStatus);

        var activeProfileLabel = E('div', { style: 'font-size:0.82em;color:#8b949e;margin-bottom:10px;' }, 'Профиль: не выбран');
        self._activeProfileLabel = activeProfileLabel;

        /* Логи — внутри карточки «Статус», под кнопками Старт/Стоп */
        var logsEl = E('pre', {
            style: 'background:#0a0518;color:#c4a0ff;padding:10px;min-height:240px;max-height:320px;overflow-y:auto;' +
                   'border-radius:6px;font-size:0.75em;white-space:pre-wrap;word-break:break-all;' +
                   'margin:0;border:1px solid rgba(138,92,246,0.2);'
        }, 'Загрузка логов...');
        self._logsEl = logsEl;

        var statusSection = card('Статус', [
            E('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:14px;' },
                [badgeEl, statusMetaEl]),
            activeProfileLabel,
            E('div', { style: 'margin-bottom:14px;' }, [startBtn, stopBtn]),
            E('div', { class: 'olcrtc-subhead', style: 'margin:0 0 6px;' }, 'Логи'),
            logsEl
        ]);

        /* ── Helpers ────────────────────────────────────────── */
        function row(label, hint, inputEl) {
            return E('div', { class: 'olcrtc-frow', style: 'display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;' }, [
                E('label', { style: 'flex:0 0 155px;font-size:0.82em;color:#b388ff;padding-top:7px;line-height:1.4;' }, label),
                E('div', { style: 'flex:1;min-width:0;' }, [
                    inputEl,
                    hint ? E('div', { style: 'margin-top:3px;font-size:0.78em;color:#7a5f99;' }, hint) : null
                ].filter(Boolean))
            ]);
        }

        /* Вертикальная раскладка: название сверху, поле снизу */
        function rowV(label, hint, inputEl) {
            return E('div', { style: 'margin-bottom:12px;' }, [
                E('label', { style: 'display:block;font-size:0.82em;color:#b388ff;margin-bottom:5px;' }, label),
                E('div', { style: 'width:100%;' }, [inputEl]),
                hint ? E('div', { style: 'margin-top:3px;font-size:0.78em;color:#7a5f99;' }, hint) : null
            ].filter(Boolean));
        }

        /* Компактные ячейки и сетка в 2 колонки (параметры транспорта) */
        var COMPACT_INPUT = 'width:100%;box-sizing:border-box;padding:4px 8px;font-size:0.82em;';

        function cell(label, inputEl) {
            return E('div', {}, [
                E('label', { style: 'display:block;font-size:0.72em;color:#b388ff;margin-bottom:3px;' }, label),
                inputEl
            ]);
        }

        function grid2(items) {
            return E('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;' }, items);
        }

        function sectionHead(text) {
            return E('div', { style: 'margin-bottom:8px;padding:3px 0;font-size:0.78em;color:#9a7fc0;' +
                                'text-transform:uppercase;letter-spacing:0.05em;' +
                                'border-bottom:1px solid rgba(138,92,246,0.15);' }, text);
        }

        function makeDebounced(fieldName, onChange) {
            var timer;
            return {
                change: function (ev) {
                    clearTimeout(timer);
                    var v = ev.target.value.trim();
                    self._saveField(fieldName, v);
                    if (onChange) onChange(v);
                },
                input: function (ev) {
                    var v = ev.target.value;
                    clearTimeout(timer);
                    timer = setTimeout(function () {
                        var t = v.trim();
                        self._saveField(fieldName, t);
                        if (onChange) onChange(t);
                    }, 600);
                }
            };
        }

        function numInput(fieldName, val, placeholder, min, max) {
            var attrs = {
                class: 'cbi-input-text', type: 'number',
                value: val, placeholder: placeholder, min: String(min),
                style: COMPACT_INPUT,
                change: function (ev) {
                    var v = parseInt(ev.target.value, 10);
                    if (!isNaN(v) && v >= min && (max == null || v <= max))
                        self._saveField(fieldName, String(v));
                }
            };
            if (max != null) attrs.max = String(max);
            return E('input', attrs);
        }

        /* ── Матрица совместимости ───────────────────────────── */
        var matrixCells = {};

        var TH_STYLE  = 'padding:4px 10px;text-align:center;font-size:0.8em;color:#9a7fc0;font-weight:normal;border-bottom:1px solid rgba(138,92,246,0.18);';
        var THL_STYLE = 'padding:4px 10px;text-align:left;font-size:0.8em;color:#9a7fc0;font-weight:normal;border-bottom:1px solid rgba(138,92,246,0.18);';

        function cellStyle(isCur, status) {
            var bg = '';
            if (isCur) bg = 'background:rgba(63,185,80,0.10);';
            else if (status === 1) bg = 'background:rgba(210,153,34,0.06);';
            return 'padding:4px 10px;text-align:center;font-size:0.85em;' + bg;
        }

        function makeCell(carrier, transport) {
            var st    = compatStatus(carrier, transport);
            var isCur = (carrier === cfg.carrier && transport === cfg.transport);
            var ic    = statusIcon(st);
            var td    = E('td', { style: cellStyle(isCur, st) },
                E('span', { style: 'color:' + ic.color + ';font-size:1.1em;' }, ic.ch));
            matrixCells[carrier + '-' + transport] = td;
            return td;
        }

        function updateMatrix(selC, selT) {
            CARRIERS.forEach(function (c) {
                TRANSPORTS.forEach(function (t) {
                    var td    = matrixCells[c + '-' + t];
                    var st    = compatStatus(c, t);
                    var isCur = (c === selC && t === selT);
                    var ic    = statusIcon(st);
                    td.style.cssText = cellStyle(isCur, st);
                    var icon = td.querySelector('span');
                    if (icon) icon.style.cssText = 'color:' + ic.color + ';font-size:1.1em;';
                    var thEl = matrixCells['__th_' + c];
                    if (thEl) thEl.style.color = (c === selC) ? '#e6edf3' : '#8b949e';
                });
            });
        }
        self._updateMatrix = updateMatrix;

        var headerCells = [E('th', { style: THL_STYLE }, '')].concat(
            CARRIERS.map(function (c) {
                var th = E('th', { style: TH_STYLE + (c === cfg.carrier ? 'color:#e6edf3;' : '') }, CARRIER_NAMES[c]);
                matrixCells['__th_' + c] = th;
                return th;
            })
        );

        var matrixRows = TRANSPORTS.map(function (t) {
            return E('tr', {}, [E('td', { style: 'padding:4px 10px;font-size:0.8em;color:#8b949e;' }, TRANSPORT_LABELS[t])].concat(
                CARRIERS.map(function (c) { return makeCell(c, t); })
            ));
        });

        var matrixLegend = E('div', { style: 'font-size:0.75em;color:#8b949e;margin-top:6px;' }, [
            E('span', { style: 'color:#3fb950;' }, '✓ работает'), ' · ',
            E('span', { style: 'color:#d29922;' }, '~ нестабильно'), ' · ',
            E('span', { style: 'color:#f85149;' }, '✗ не работает')
        ]);

        var matrixTable = E('table', { style: 'border-collapse:collapse;margin-bottom:4px;' }, [
            E('thead', {}, [E('tr', {}, headerCells)]),
            E('tbody', {}, matrixRows)
        ]);

        /* ── Carrier / Transport ─────────────────────────────── */
        var allowed = TRANSPORTS.filter(function (t) { return compatStatus(cfg.carrier, t) > 0; });

        var carrierSel = E('select', {
            class  : 'cbi-input-select',
            change : function (ev) {
                var c = ev.target.value;
                self._saveField('carrier', c);
                self._updateTransportOptions(c);
                self._updateCarrierSections(c);
                updateMatrix(c, transportSel.value);
                self._checkServerSelection('carrier', c);
                self._refreshActiveProfile();
            }
        }, [
            E('option', { value: 'jitsi',    selected: cfg.carrier === 'jitsi'    ? '' : null }, 'Jitsi (meet.jit.si или self-hosted)'),
            E('option', { value: 'telemost', selected: cfg.carrier === 'telemost' ? '' : null }, 'Telemost (telemost.yandex.ru)'),
            E('option', { value: 'wbstream', selected: cfg.carrier === 'wbstream' ? '' : null }, 'Wildberries Stream (stream.wb.ru)'),
            E('option', { value: 'none',     selected: cfg.carrier === 'none'     ? '' : null }, 'none — прямой engine (SFU)')
        ]);
        self._carrierSel = carrierSel;

        var transportSel = E('select', {
            class  : 'cbi-input-select',
            change : function (ev) {
                var t = ev.target.value;
                self._saveField('transport', t);
                updateMatrix(carrierSel.value, t);
                self._updateTransportSections(t);
                self._checkServerSelection('transport', t);
                self._refreshActiveProfile();
            }
        }, [
            E('option', { value: 'datachannel',  selected: cfg.transport === 'datachannel'  ? '' : null, disabled: allowed.indexOf('datachannel')  === -1 ? '' : null }, 'datachannel — максимальная скорость (рекомендуется для Jitsi)'),
            E('option', { value: 'vp8channel',   selected: cfg.transport === 'vp8channel'   ? '' : null, disabled: allowed.indexOf('vp8channel')   === -1 ? '' : null }, 'vp8channel — работает почти везде (для Telemost обязателен)'),
            E('option', { value: 'seichannel',   selected: cfg.transport === 'seichannel'   ? '' : null, disabled: allowed.indexOf('seichannel')   === -1 ? '' : null }, 'seichannel — только WBStream'),
            E('option', { value: 'videochannel', selected: cfg.transport === 'videochannel' ? '' : null, disabled: allowed.indexOf('videochannel') === -1 ? '' : null }, 'videochannel — крайний случай')
        ]);
        self._transportSel = transportSel;

        /* ── Поля подключения ───────────────────────────────── */
        var roomH = makeDebounced('room_id',   function (v) { self._checkServerSelection('room_id', v); self._refreshActiveProfile(); });
        var roomInput = E('input', { class: 'cbi-input-text', type: 'text', value: cfg.room_id, placeholder: 'https://meet.example.org/room или ID комнаты', change: roomH.change, input: roomH.input });
        self._roomInput = roomInput;

        var keyH = makeDebounced('key', function (v) { self._checkServerSelection('key', v); self._refreshActiveProfile(); });
        var keyInput = E('input', { class: 'cbi-input-text', type: 'password', value: cfg.key, placeholder: 'e5265a924657a8807dc...', change: keyH.change, input: keyH.input });
        self._keyInput = keyInput;

        /* ── SOCKS5 ─────────────────────────────────────────── */
        var socksHostH = makeDebounced('socks_host');
        var socksHostInput  = E('input', { class: 'cbi-input-text', type: 'text',     value: cfg.socks_host, placeholder: '127.0.0.1', change: socksHostH.change, input: socksHostH.input });
        var socksPortInput  = E('input', { class: 'cbi-input-text', type: 'number',   value: cfg.socks_port, placeholder: '1080', min: '1', max: '65535', change: function (ev) { var v = parseInt(ev.target.value, 10); if (v >= 1 && v <= 65535) self._saveField('socks_port', String(v)); } });
        var socksUserH      = makeDebounced('socks_user');
        var socksUserInput  = E('input', { class: 'cbi-input-text', type: 'text',     value: cfg.socks_user, placeholder: '(без аутентификации — оставьте пустым)', change: socksUserH.change, input: socksUserH.input });
        var socksPassH      = makeDebounced('socks_pass');
        var socksPassInput  = E('input', { class: 'cbi-input-text', type: 'password', value: cfg.socks_pass, placeholder: '(без аутентификации — оставьте пустым)', change: socksPassH.change, input: socksPassH.input });

        var socksProxyAddrH = makeDebounced('socks_proxy_addr');
        var socksProxyAddrInput = E('input', { class: 'cbi-input-text', type: 'text', value: cfg.socks_proxy_addr, placeholder: '10.0.0.5', change: socksProxyAddrH.change, input: socksProxyAddrH.input });
        var socksProxyPortInput = E('input', { class: 'cbi-input-text', type: 'number', value: cfg.socks_proxy_port, placeholder: '1080', min: '1', max: '65535', change: function (ev) { var v = parseInt(ev.target.value, 10); if (v >= 1 && v <= 65535) self._saveField('socks_proxy_port', String(v)); } });
        var socksProxyUserH = makeDebounced('socks_proxy_user');
        var socksProxyUserInput = E('input', { class: 'cbi-input-text', type: 'text', value: cfg.socks_proxy_user, placeholder: '(пусто = без аутентификации)', change: socksProxyUserH.change, input: socksProxyUserH.input });
        var socksProxyPassH = makeDebounced('socks_proxy_pass');
        var socksProxyPassInput = E('input', { class: 'cbi-input-text', type: 'password', value: cfg.socks_proxy_pass, placeholder: '(пусто = без аутентификации)', change: socksProxyPassH.change, input: socksProxyPassH.input });

        /* ── DNS / Debug / Provider ──────────────────────────── */
        var dnsH = makeDebounced('dns');
        var dnsInput = E('input', { class: 'cbi-input-text', type: 'text', value: cfg.dns, placeholder: '1.1.1.1:53', change: dnsH.change, input: dnsH.input });

        var authTokenH = makeDebounced('auth_token');
        var authTokenInput = E('input', { class: 'cbi-input-text', type: 'password', value: cfg.auth_token, placeholder: '(пусто = гостевой вход)', change: authTokenH.change, input: authTokenH.input });

        var roomChannelH = makeDebounced('room_channel');
        var roomChannelInput = E('input', { class: 'cbi-input-text', type: 'text', value: cfg.room_channel, placeholder: '(обычно пусто)', change: roomChannelH.change, input: roomChannelH.input });

        var debugCheck = E('input', {
            type: 'checkbox', checked: cfg.debug === '1' ? '' : null,
            style: 'width:auto;margin-right:6px;',
            change: function (ev) { self._saveField('debug', ev.target.checked ? '1' : '0'); }
        });

        /* ── Engine (auth.provider: none) ────────────────────── */
        var engineNameSel = E('select', {
            class  : 'cbi-input-select',
            change : function (ev) { self._saveField('engine_name', ev.target.value); }
        }, [
            E('option', { value: 'livekit', selected: cfg.engine_name === 'livekit' ? '' : null }, 'livekit'),
            E('option', { value: 'goolom',  selected: cfg.engine_name === 'goolom'  ? '' : null }, 'goolom'),
            E('option', { value: 'jitsi',   selected: cfg.engine_name === 'jitsi'   ? '' : null }, 'jitsi')
        ]);
        var engineUrlH = makeDebounced('engine_url');
        var engineUrlInput = E('input', { class: 'cbi-input-text', type: 'text', value: cfg.engine_url, placeholder: 'wss://… или https://…', change: engineUrlH.change, input: engineUrlH.input });
        var engineTokenH = makeDebounced('engine_token');
        var engineTokenInput = E('input', { class: 'cbi-input-text', type: 'password', value: cfg.engine_token, placeholder: '(пусто = без токена)', change: engineTokenH.change, input: engineTokenH.input });

        var engineSection = E('div', {}, [
            E('hr', { style: HR_STYLE }),
            E('div', { class: 'olcrtc-subhead' }, 'Прямой engine — auth.provider: none'),
            rowV('engine.name',  'livekit / goolom / jitsi. SFU-движок для прямого подключения.', engineNameSel),
            rowV('engine.url',   'URL SFU-сервера (без него соединение не установится).', engineUrlInput),
            rowV('engine.token', 'Токен доступа к SFU, если требуется.', engineTokenInput)
        ]);
        self._engineSection = engineSection;

        /* ── Параметры транспортов ───────────────────────────── */
        var vp8FpsInput   = numInput('vp8_fps',   cfg.vp8_fps,   '30', 1, 120);
        var vp8BatchInput = numInput('vp8_batch', cfg.vp8_batch, '64', 1, null);
        var vp8Section = E('div', {}, [
            sectionHead('VP8 Channel · fps 30 · batch 64'),
            grid2([
                cell('vp8.fps',        vp8FpsInput),
                cell('vp8.batch_size', vp8BatchInput)
            ])
        ]);
        self._vp8Section = vp8Section;

        var seiFpsInput   = numInput('sei_fps',   cfg.sei_fps,   '30',   1, 120);
        var seiBatchInput = numInput('sei_batch', cfg.sei_batch, '64',   1, null);
        var seiFragInput  = numInput('sei_frag',  cfg.sei_frag,  '900',  1, null);
        var seiAckInput   = numInput('sei_ack_ms', cfg.sei_ack_ms, '2000', 1, null);
        var seiSection = E('div', {}, [
            sectionHead('SEI Channel · fps 30 · batch 64 · frag 900 · ack 2000'),
            grid2([
                cell('sei.fps',           seiFpsInput),
                cell('sei.batch_size',    seiBatchInput),
                cell('sei.fragment_size', seiFragInput),
                cell('sei.ack_timeout_ms', seiAckInput)
            ])
        ]);
        self._seiSection = seiSection;

        var videoCodecSel = E('select', { class: 'cbi-input-select', change: function (ev) { self._saveField('video_codec', ev.target.value); self._updateVideoCodecRows(ev.target.value); } }, [
            E('option', { value: 'qrcode', selected: cfg.video_codec === 'qrcode' ? '' : null }, 'qrcode (рекомендуется)'),
            E('option', { value: 'tile',   selected: cfg.video_codec === 'tile'   ? '' : null }, 'tile (требует 1080×1080)')
        ]);
        var videoWInput       = numInput('video_w',   cfg.video_w,   '1080', 1, null);
        var videoHInput       = numInput('video_h',   cfg.video_h,   '1080', 1, null);
        var videoFpsInput     = numInput('video_fps', cfg.video_fps, '30',   1, 120);
        var bitrateH          = makeDebounced('video_bitrate');
        var videoBitrateInput = E('input', { class: 'cbi-input-text', type: 'text', value: cfg.video_bitrate, placeholder: '5000k', style: COMPACT_INPUT, change: bitrateH.change, input: bitrateH.input });
        var videoHwSel        = E('select', { class: 'cbi-input-select', change: function (ev) { self._saveField('video_hw', ev.target.value); } }, [
            E('option', { value: 'none',  selected: cfg.video_hw === 'none'  ? '' : null }, 'none'),
            E('option', { value: 'nvenc', selected: cfg.video_hw === 'nvenc' ? '' : null }, 'nvenc (NVIDIA GPU)')
        ]);
        var qrRecoverySel = E('select', { class: 'cbi-input-select', change: function (ev) { self._saveField('video_qr_recovery', ev.target.value); } }, [
            E('option', { value: 'low',     selected: cfg.video_qr_recovery === 'low'     ? '' : null }, 'low'),
            E('option', { value: 'medium',  selected: cfg.video_qr_recovery === 'medium'  ? '' : null }, 'medium'),
            E('option', { value: 'high',    selected: cfg.video_qr_recovery === 'high'    ? '' : null }, 'high'),
            E('option', { value: 'highest', selected: cfg.video_qr_recovery === 'highest' ? '' : null }, 'highest')
        ]);
        var qrSizeInput     = numInput('video_qr_size',     cfg.video_qr_size,    '0',  0, null);
        var tileModuleInput = numInput('video_tile_module', cfg.video_tile_module, '4',  1, 270);
        var tileRsInput     = numInput('video_tile_rs',     cfg.video_tile_rs,    '20', 0, 200);

        var qrRecoveryRow = cell('video.qr_recovery', qrRecoverySel);
        var qrSizeRow     = cell('video.qr_size',     qrSizeInput);
        var tileModuleRow = cell('video.tile_module', tileModuleInput);
        var tileRsRow     = cell('video.tile_rs',     tileRsInput);
        self._qrRows   = [qrRecoveryRow, qrSizeRow];
        self._tileRows = [tileModuleRow, tileRsRow];

        var videoSection = E('div', {}, [
            sectionHead('Video Channel · qrcode 1080×1080 30fps'),
            grid2([
                cell('video.codec',   videoCodecSel),
                cell('video.hw',      videoHwSel),
                cell('video.width',   videoWInput),
                cell('video.height',  videoHInput),
                cell('video.fps',     videoFpsInput),
                cell('video.bitrate', videoBitrateInput),
                qrRecoveryRow, qrSizeRow, tileModuleRow, tileRsRow
            ])
        ]);
        self._videoSection = videoSection;

        self._transportParamInputs = {
            vp8_fps: vp8FpsInput, vp8_batch: vp8BatchInput,
            sei_fps: seiFpsInput, sei_batch: seiBatchInput, sei_frag: seiFragInput, sei_ack_ms: seiAckInput,
            video_codec: videoCodecSel, video_w: videoWInput, video_h: videoHInput,
            video_fps: videoFpsInput, video_bitrate: videoBitrateInput, video_hw: videoHwSel,
            video_qr_recovery: qrRecoverySel, video_qr_size: qrSizeInput,
            video_tile_module: tileModuleInput, video_tile_rs: tileRsInput
        };

        var datachannelHint = E('div', { style: 'color:#8b949e;font-size:0.9em;padding:8px 0;' }, 'datachannel не имеет дополнительных параметров — всё по умолчанию.');
        self._datachannelHint = datachannelHint;

        self._updateTransportSections(cfg.transport);
        self._updateVideoCodecRows(cfg.video_codec);
        self._updateCarrierSections(cfg.carrier);

        /* ── Надёжность и лимиты ────────────────────────────── */
        var livenessIntervalH = makeDebounced('liveness_interval');
        var livenessIntervalInput = E('input', { class: 'cbi-input-text', type: 'text', value: cfg.liveness_interval, placeholder: '10s', change: livenessIntervalH.change, input: livenessIntervalH.input });

        var livenessTimeoutH = makeDebounced('liveness_timeout');
        var livenessTimeoutInput = E('input', { class: 'cbi-input-text', type: 'text', value: cfg.liveness_timeout, placeholder: '5s', change: livenessTimeoutH.change, input: livenessTimeoutH.input });

        var livenessFailuresInput = numInput('liveness_failures', cfg.liveness_failures, '3', 1, null);

        var lifecycleH = makeDebounced('lifecycle_max_session_duration');
        var lifecycleInput = E('input', { class: 'cbi-input-text', type: 'text', value: cfg.lifecycle_max_session_duration, placeholder: '6h (пусто = выключено)', change: lifecycleH.change, input: lifecycleH.input });

        var trafficPayloadInput = numInput('traffic_max_payload_size', cfg.traffic_max_payload_size, '0', 0, null);

        var trafficMinH = makeDebounced('traffic_min_delay');
        var trafficMinInput = E('input', { class: 'cbi-input-text', type: 'text', value: cfg.traffic_min_delay, placeholder: '5ms', change: trafficMinH.change, input: trafficMinH.input });

        var trafficMaxH = makeDebounced('traffic_max_delay');
        var trafficMaxInput = E('input', { class: 'cbi-input-text', type: 'text', value: cfg.traffic_max_delay, placeholder: '30ms', change: trafficMaxH.change, input: trafficMaxH.input });

        var reliabilityCard = card('Надёжность и лимиты (опционально)', [
            row('liveness.interval',   'Пинг контрольного потока. По умолчанию: 10s.', livenessIntervalInput),
            row('liveness.timeout',    'Ожидание ответа на ping. По умолчанию: 5s.',   livenessTimeoutInput),
            row('liveness.failures',   'Пропущенных pong до переподключения. По умолчанию: 3.', livenessFailuresInput),
            row('lifecycle.max_session_duration', 'Плановая переподключение сессии, напр. 6h. Пусто = выключено.', lifecycleInput),
            row('traffic.max_payload_size', 'Лимит полезной нагрузки (0 = лимит транспорта).', trafficPayloadInput),
            row('traffic.min_delay',   'Необязательная задержка перед отправкой, напр. 5ms.', trafficMinInput),
            row('traffic.max_delay',   'Верхняя граница задержки, напр. 30ms.', trafficMaxInput)
        ]);

        /* ── URI / Подписки ─────────────────────────────────── */
        var uriLabel = E('span', { style: 'margin-left:10px;font-size:0.85em;vertical-align:middle;' }, '');
        self._uriLabel = uriLabel;

        var uriInput = E('input', {
            class       : 'cbi-input-text',
            type        : 'text',
            placeholder : 'olcrtc://… или https://example.com/sub.txt',
            style       : 'font-family:monospace;font-size:0.82em;width:100%;',
            input       : function (ev) {
                var val = ev.target.value.trim();

                if (!val) {
                    uriLabel.textContent    = '';
                    ev.target.style.outline = '';
                    return;
                }

                /* Ссылка на подписку */
                if (val.indexOf('http://') === 0 || val.indexOf('https://') === 0) {
                    self._addSubscription(val);
                    return;
                }

                /* Прямой URI olcrtc:// → создать профиль */
                var p = parseOlcrtcUri(val);
                if (!p) {
                    uriLabel.textContent    = '✗ Неверный формат';
                    uriLabel.style.color    = '#f85149';
                    ev.target.style.outline = '2px solid #f85149';
                    return;
                }

                var name = (p.mimo || '').trim().replace(/\s+/g, ' ') ||
                           ((CARRIER_NAMES[p.carrier] || p.carrier) + ' ' + (TRANSPORT_LABELS[p.transport] || p.transport));

                /* Дубликат по той же ссылке → просто активировать */
                var dup = null;
                (self._profiles || []).forEach(function (e) { if (e.uri === val) dup = e; });
                if (dup) {
                    self._applyProfile(dup);
                    uriLabel.textContent    = '✓ Профиль «' + dup.name + '» уже есть — активирован';
                    uriLabel.style.color    = '#3fb950';
                    ev.target.style.outline = '2px solid #3fb950';
                    ev.target.value = '';
                    setTimeout(function () {
                        if (self._uriInput) self._uriInput.style.outline = '';
                        if (self._uriLabel) self._uriLabel.textContent   = '';
                    }, 2500);
                    return;
                }

                callUciAdd('olcrtc', 'profile')
                    .then(function (sectionName) {
                        return callUciSet('olcrtc', sectionName, { name: name, uri: val })
                            .then(function () { return callUciCommit('olcrtc'); })
                            .then(function () {
                                var e = self._createProfileEntry(sectionName, val);
                                uriLabel.textContent    = '✓ Профиль «' + (e ? e.name : name) + '» добавлен' +
                                    (self._profiles.length > 1 ? '' : '. Нажмите на него, чтобы активировать.');
                                uriLabel.style.color    = '#3fb950';
                                ev.target.style.outline = '2px solid #3fb950';
                                ev.target.value = '';
                                setTimeout(function () {
                                    if (self._uriInput) self._uriInput.style.outline = '';
                                    if (self._uriLabel) self._uriLabel.textContent   = '';
                                }, 2500);
                            });
                    })
                    .catch(function (err) {
                        console.error('[OlcRTC] add profile error:', err);
                        uriLabel.textContent    = '✗ Не удалось сохранить профиль';
                        uriLabel.style.color    = '#f85149';
                        ev.target.style.outline = '2px solid #f85149';
                    });
            }
        });
        self._uriInput = uriInput;

        /* Контейнер для всех блоков подписок */
        var subsContainer = E('div', {});
        self._subsContainer = subsContainer;

        /* Контейнер профилей */
        var profilesContainer = E('div', { style: 'display:flex;flex-wrap:wrap;gap:10px;' });
        self._profilesContainer = profilesContainer;

        /* Предпросмотр сгенерированного конфига */
        var cfgPreview = E('pre', {
            style: 'display:none;margin-top:8px;background:#0a0518;color:#c4a0ff;padding:10px;' +
                   'border-radius:6px;font-size:0.72em;white-space:pre-wrap;word-break:break-all;' +
                   'max-height:260px;overflow-y:auto;border:1px solid rgba(138,92,246,0.2);'
        }, '');
        var cfgPreviewBtn = E('button', {
            class : 'btn cbi-button cbi-button-apply',
            style : 'font-size:0.8em;padding:4px 12px;',
            click : function () {
                cfgPreview.style.display = '';
                cfgPreview.textContent = 'Загрузка...';
                return callExec('/bin/cat', ['/etc/olcrtc/client.yaml'], null)
                    .then(function (res) {
                        cfgPreview.textContent = res || '(файл пуст — запустите сервис)';
                    })
                    .catch(function (e) {
                        cfgPreview.textContent = 'Ошибка чтения client.yaml: ' + (e.message || e);
                    });
            }
        }, 'Показать текущий client.yaml');

        var uriSection = card('Подключение по URI / Профили', [
            E('div', { style: 'margin-bottom:4px;' }, [uriInput, uriLabel]),
            E('div', { style: 'font-size:0.82em;color:#7a5f99;margin-bottom:12px;' },
                'Вставьте olcrtc://… — создастся профиль, имя берётся из $… в конце ссылки. ' +
                'Переключение между сервисами (WBStream, Telemost, …) — кликом по профилю. ' +
                'Для Jitsi Room ID — это URL вида https://host/room. ' +
                'https:// ссылку на подписку (sub.md) — в раздел «Подписки».'),
            E('div', { class: 'olcrtc-subhead' }, 'Профили'),
            profilesContainer,
            E('div', { class: 'olcrtc-subhead', style: 'margin-top:6px;' }, 'Подписки'),
            subsContainer,
            E('div', { style: 'margin-top:12px;' }, [cfgPreviewBtn, cfgPreview])
        ]);

        /* ── Карточки ─────────────────────────────────────────── */
        var matrixCard = card('Совместимость', [
            E('div', { style: 'overflow-x:auto;' }, [matrixTable]),
            matrixLegend
        ]);

        var settingsCard = card('Базовые настройки подключения', [
            row('Сервис',    'Через какой сервис идёт туннель. none = прямой engine. Рекомендуется Jitsi + datachannel.', carrierSel),
            row('Транспорт', 'Протокол передачи данных внутри туннеля.', transportSel),
            E('hr', { style: HR_STYLE }),
            row('Room ID',         'Для Jitsi — URL комнаты; для Telemost/WBStream — ID с сервера.', roomInput),
            row('Ключ шифрования', 'HEX-строка 64 символа. openssl rand -hex 32.', keyInput),
            engineSection
        ]);

        var socksCard = card('SOCKS5 прокси', [
            rowV('Адрес (socks.host)',  '127.0.0.1 — только локально. Для сети нужен логин+пароль.', socksHostInput),
            rowV('Порт (socks.port)',   'Локальный порт прокси. По умолчанию: 1080.',                 socksPortInput),
            rowV('Логин (socks.user)',  'RFC 1929. Пусто = без аутентификации.',                      socksUserInput),
            rowV('Пароль (socks.pass)', 'Используется вместе с логином. Обязателен при не-loopback адресе.', socksPassInput),
            E('div', { class: 'olcrtc-subhead' }, 'Исходящий прокси (серверная сторона)'),
            rowV('Адрес (socks.proxy_addr)',  'SOCKS5-прокси для исходящего трафика туннеля. Пусто = без прокси.', socksProxyAddrInput),
            rowV('Порт (socks.proxy_port)',   'Порт исходящего прокси.',                                  socksProxyPortInput),
            rowV('Логин (socks.proxy_user)',  'RFC 1929. Пусто = соединение без аутентификации.',         socksProxyUserInput),
            rowV('Пароль (socks.proxy_pass)', 'Используется вместе с логином.',                            socksProxyPassInput)
        ]);

        var advancedCard = card('Дополнительно', [
            row('DNS-сервер (net.dns)', 'DNS для резолвинга в туннеле. По умолчанию: 1.1.1.1:53.', dnsInput),
            row('Auth Token (auth.token)', 'Токен аккаунта/модератора WBStream. Пусто = гость. Нужен для datachannel через WBStream.', authTokenInput),
            row('Room Channel (room.channel)', 'Необязательный канал для peer-routing. Обычно пусто.', roomChannelInput),
            row('Режим отладки (debug)', 'Подробные логи WebRTC-соединений.',
                E('label', { style: 'display:flex;align-items:center;cursor:pointer;' }, [debugCheck, E('span', {}, 'Включить логирование')]))
        ]);
        advancedCard.style.flex = '1';
        advancedCard.style.marginTop = '16px';

        var transportCard = card('Параметры транспорта', [
            datachannelHint, vp8Section, seiSection, videoSection
        ]);

        self._startPolling();

        /* Загрузить сохранённые подписки */
        var savedSubs = uci.sections('olcrtc', 'subscription') || [];
        savedSubs.forEach(function (section) {
            var sectionName = section['.name'];
            var url = section.url || '';
            if (url) self._createSubBlock(sectionName, url);
        });

        /* Загрузить сохранённые профили */
        var savedProfiles = uci.sections('olcrtc', 'profile') || [];
        savedProfiles.forEach(function (section) {
            var sectionName = section['.name'];
            var uri = section.uri || '';
            if (uri) self._createProfileEntry(sectionName, uri);
        });
        self._refreshActiveProfile();

        function flexRow(children, extra) {
            return E('div', { class: 'olcrtc-row', style: 'display:flex;gap:16px;margin-bottom:16px;align-items:stretch;' + (extra || '') }, children);
        }
        function col(flex, cardEl) {
            if (cardEl && cardEl.style) cardEl.style.flex = '1';
            return E('div', { class: 'olcrtc-col', style: 'display:flex;flex-direction:column;flex:' + flex + ';min-width:0;' }, [cardEl]);
        }

        /* ── Тема (фиолетовая по умолчанию / синяя LuCI) ────── */
        self._theme = 'purple';
        try {
            if (typeof localStorage !== 'undefined' && localStorage.getItem('olcrtc_theme'))
                self._theme = localStorage.getItem('olcrtc_theme');
        } catch (e) {}
        if (self._theme !== 'luci') self._theme = 'purple';
        var themeBtn = E('button', {
            class : 'btn cbi-button cbi-button-apply',
            style : 'position:absolute;top:0;right:0;font-size:0.78em;padding:3px 12px;',
            click : ui.createHandlerFn(self, function () {
                self._theme = (self._theme === 'luci') ? 'purple' : 'luci';
                root.className = 'olcrtc-theme' + (self._theme === 'luci' ? ' luci' : '');
                themeBtn.textContent = (self._theme === 'luci') ? 'Тема: синяя' : 'Тема: фиолетовая';
                try { localStorage.setItem('olcrtc_theme', self._theme); } catch (e) {}
                self._toast('Тема: ' + (self._theme === 'luci' ? 'синяя' : 'фиолетовая'));
            })
        }, self._theme === 'luci' ? 'Тема: синяя' : 'Тема: фиолетовая');

        /* ── Тост «Сохранено» ───────────────────────────────── */
        var toastEl = E('div', { class: 'olcrtc-toast' }, '');
        self._toastTimer = null;
        self._toast = function (msg) {
            toastEl.textContent = msg;
            toastEl.style.opacity = '1';
            toastEl.style.transform = 'translateY(0)';
            if (self._toastTimer) clearTimeout(self._toastTimer);
            self._toastTimer = setTimeout(function () {
                toastEl.style.opacity = '0';
                toastEl.style.transform = 'translateY(12px)';
            }, 2200);
        };

        var root = E('div', {
            style: 'background:linear-gradient(160deg,#06011a 0%,#04091a 100%);' +
                   'border-radius:16px;padding:24px 28px;width:100%;box-sizing:border-box;position:relative;'
        }, [
            /* Стили карточек и индикаторов */
            E('style', {}, OLCRTC_STYLE),

            /* Заголовок */
            E('div', { style: 'position:relative;text-align:center;margin-bottom:24px;' }, [
                E('div', {
                    class : 'olcrtc-title',
                    style : 'font-size:1.45em;font-weight:700;color:#e2d9f3;letter-spacing:0.02em;margin-bottom:6px;'
                }, 'OpenWRT OlcRTC Panel'),
                E('div', { class: 'olcrtc-under', style: 'width:60px;height:2px;' +
                    'background:linear-gradient(90deg,#8a5cf6,#c084fc);margin:0 auto;border-radius:1px;' }),
                themeBtn
            ]),

            /* Строка 1: Статус (с логами) + URI/Подписки */
            flexRow([
                col(2, statusSection),
                col(3, uriSection)
            ]),

            /* Строка 2: Совместимость + Базовые настройки */
            flexRow([
                col(2, matrixCard),
                col(3, settingsCard)
            ]),

            /* Строка 3: SOCKS5 + [Транспорт + Дополнительно в стопке] + Надёжность и лимиты */
            flexRow([
                col(2, socksCard),
                col(2, E('div', { style: 'display:flex;flex-direction:column;min-width:0;' }, [
                    E('div', { style: 'margin-bottom:16px;' }, [transportCard]),
                    advancedCard
                ])),
                col(3, reliabilityCard)
            ]),

            /* Подвал */
            E('div', { style: 'text-align:center;margin-top:20px;padding-top:16px;' +
                              'border-top:1px solid rgba(138,92,246,0.15);font-size:0.78em;color:#6b5280;' }, [
                'Обновлённая панель по актуальным докам olcrtc. Проект — ',
                E('a', {
                    href   : 'https://github.com/skorp505/OlcRTC-OpenWRT',
                    target : '_blank',
                    style  : 'color:#8a5cf6;text-decoration:none;'
                }, 'OlcRTC-OpenWRT')
            ]),

            /* Тост — поверх всей панели, справа снизу */
            toastEl
        ]);

        root.className = 'olcrtc-theme' + (self._theme === 'luci' ? ' luci' : '');
        return root;
    },

    handleSave      : function () { return Promise.resolve(); },
    handleSaveApply : function () { return Promise.resolve(); },
    handleReset     : function () { return Promise.resolve(); }
});
