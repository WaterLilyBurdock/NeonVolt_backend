/* ═════════════════════════════════════════════════════════════════════════
   NEON VOLT — локальный сервер для VK Play
   • раздаёт игру (index.html, vkplay-billing.js, ...)
   • принимает callback об оплате с проверкой подписи
   • хранит покупки и рекорды в data/*.json

   Запуск:
     set VKPLAY_GAME_SECRET=ваш_секрет_из_системных_свойств
     node server.js

   Для HTTPS задайте TLS_KEY и TLS_CERT (пути к ключу и сертификату).
   В дашборде VK Play поле «Callback URL»:
     https://ваш-домен/api/billing/
   ═════════════════════════════════════════════════════════════════════════ */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PURCHASES_FILE = path.join(DATA_DIR, 'purchases.json');
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');
const SECRET = process.env.VKPLAY_GAME_SECRET || '';
const PORT = Number(process.env.PORT || 8080);

const VALID_ITEMS = new Set(['neon_supporter', 'neon_revive', 'neon_legend']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav'
};

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const file of [PURCHASES_FILE, SCORES_FILE]) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', 'utf8');
  }
}

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value) ? value : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ─── Callback оплаты ────────────────────────────────────────────────── */
function handleBilling(res, params) {
  const uid = params.get('uid') || '';
  const sum = params.get('sum') || '';
  const tid = params.get('tid') || '';
  const merchantParam = params.get('merchant_param') || '';
  const sign = params.get('sign') || '';

  if (!uid || !sum || !tid || !merchantParam || !sign) {
    return json(res, 400, { status: 'error', errcode: 2000, errmsg: 'Missing parameters' });
  }
  if (!SECRET) {
    return json(res, 500, { status: 'error', errcode: 5001, errmsg: 'VKPLAY_GAME_SECRET is not configured' });
  }

  const sorted = { merchant_param: merchantParam, sum: sum, tid: tid, uid: uid };
  const source = 'merchant_param=' + sorted.merchant_param +
                 'sum=' + sorted.sum +
                 'tid=' + sorted.tid +
                 'uid=' + sorted.uid + SECRET;
  const expected = crypto.createHash('md5').update(source, 'utf8').digest('hex');

  if (!safeEqual(expected, sign)) {
    console.warn('[billing] invalid signature', { uid, tid, sign });
    return json(res, 403, { status: 'error', errcode: 5001, errmsg: 'Invalid signature' });
  }

  let mp = {};
  try { mp = JSON.parse(merchantParam); } catch (e) {}

  const purchases = readJson(PURCHASES_FILE, []);
  if (purchases.some(p => p.tid === tid)) {
    return json(res, 200, { status: 'ok' });
  }

  purchases.push({
    tid: tid,
    uid: uid,
    sum: sum,
    item_id: mp.item_id || '',
    amount: mp.amount != null ? mp.amount : null,
    original_amount: mp.original_amount != null ? mp.original_amount : null,
    original_currency: mp.original_currency || mp.currency || '',
    description: mp.description || '',
    additional_param: mp.additional_param || '',
    merchant_param: merchantParam,
    paid_at: new Date().toISOString()
  });
  writeJson(PURCHASES_FILE, purchases);

  console.log('[billing] payment saved', { uid, tid, item_id: mp.item_id, sum });
  return json(res, 200, { status: 'ok' });
}

/* ─── Раздача покупок клиенту ────────────────────────────────────────── */
function handleEntitlements(res, params) {
  const uid = params.get('uid') || '';
  if (!uid) return json(res, 400, { status: 'error', errmsg: 'uid is required' });

  const purchases = readJson(PURCHASES_FILE, []);
  const items = [...new Set(
    purchases
      .filter(p => p.uid === uid && VALID_ITEMS.has(p.item_id))
      .map(p => p.item_id)
  )];

  return json(res, 200, { status: 'ok', uid: uid, items: items });
}

/* ─── Рекорды ────────────────────────────────────────────────────────── */
function handleScore(req, res, params) {
  const uid = params.get('uid') || '';
  if (!uid) return json(res, 400, { status: 'error', errmsg: 'uid is required' });

  const scores = readJson(SCORES_FILE, []);
  const found = scores.find(s => s.uid === uid);

  if (req.method === 'POST') {
    const raw = params.get('score');
    const score = Number(raw);
    if (!Number.isFinite(score) || score < 0) {
      return json(res, 400, { status: 'error', errmsg: 'invalid score' });
    }
    if (found) {
      found.score = Math.max(Number(found.score) || 0, Math.floor(score));
      found.updated_at = new Date().toISOString();
    } else {
      scores.push({ uid: uid, score: Math.floor(score), updated_at: new Date().toISOString() });
    }
    writeJson(SCORES_FILE, scores);
  }

  return json(res, 200, { status: 'ok', score: found ? Number(found.score) || 0 : 0 });
}

/* ─── Статика ────────────────────────────────────────────────────────── */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));

  if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, 'index.html')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ─── Сервер ─────────────────────────────────────────────────────────── */
function handler(req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  const params = parsed.searchParams;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  if (pathname.startsWith('/api/billing')) return handleBilling(res, params);
  if (pathname === '/api/entitlements') return handleEntitlements(res, params);
  if (pathname === '/api/score') return handleScore(req, res, params);
  if (pathname.startsWith('/api/')) return json(res, 404, { status: 'error', errmsg: 'Unknown API' });

  return serveStatic(req, res, pathname);
}

ensureStorage();

const server = process.env.TLS_KEY && process.env.TLS_CERT
  ? https.createServer({
      key: fs.readFileSync(process.env.TLS_KEY),
      cert: fs.readFileSync(process.env.TLS_CERT)
    }, handler)
  : http.createServer(handler);

server.listen(PORT, () => {
  const proto = process.env.TLS_KEY && process.env.TLS_CERT ? 'https' : 'http';
  console.log('NeonVolt server: ' + proto + '://localhost:' + PORT);
  console.log('Callback URL: ' + proto + '://YOUR_DOMAIN/api/billing/');
  if (!SECRET) console.warn('WARNING: VKPLAY_GAME_SECRET is not set — callbacks will be rejected.');
});
