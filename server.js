#!/usr/bin/env node
/**
 * GoldenTiger · 金虎水果机服务端
 * ---------------------------------------------------------------
 * 零依赖：Node 原生 http + node:sqlite + node:crypto
 * 运行：node --experimental-sqlite server.js   （或 npm start）
 * 端口：PORT 环境变量，默认 3000
 *
 * 功能：
 *   - 注册 / 登录 / 登出（用户名 + 密码，scrypt 哈希）
 *   - Session cookie（httpOnly，7 天，服务端 sessions 表）
 *   - 用户积分 / 彩池 / 最高分持久化（SQLite）
 *   - 全服排行榜（按最高分）
 *   - 账号注销（个保法合规）
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('[GoldenTiger] 当前 Node 版本不支持内置 node:sqlite。');
  console.error('[GoldenTiger] 需要 Node >= 22.5，并用 --experimental-sqlite 启动：');
  console.error('[GoldenTiger]   node --experimental-sqlite server.js');
  process.exit(1);
}

const PORT = Number(process.env.PORT || 3100);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const SESSION_DAYS = 7;
const SESSION_COOKIE = 'gt_session';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

/* ============================================================
   数据库
   ============================================================ */
const db = new DatabaseSync(path.join(DATA_DIR, 'golden-tiger.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    credits       INTEGER NOT NULL DEFAULT 100,
    jackpot       INTEGER NOT NULL DEFAULT 8888,
    best          INTEGER NOT NULL DEFAULT 100,
    rounds        INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    expires_at TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

// 启动时清理过期 session
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());

/* ============================================================
   密码哈希（scrypt + 随机盐，恒定时间比较）
   ============================================================ */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    if (!salt || !hash) return false;
    const candidate = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    if (candidate.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidate, expected);
  } catch (err) {
    return false;
  }
}

/* ============================================================
   输入校验
   ============================================================ */
const USERNAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^1\d{10}$/;

function validateUsername(raw) {
  const u = String(raw || '').trim();
  if (u.length < 3 || u.length > 20) return '用户名长度需为 3-20 个字符';
  if (u.includes('@')) {
    if (!EMAIL_RE.test(u)) return '邮箱格式不正确';
    return null;
  }
  if (/^\d+$/.test(u)) {
    if (!PHONE_RE.test(u)) return '手机号需为 11 位数字且以 1 开头';
    return null;
  }
  if (!USERNAME_RE.test(u)) return '只能使用中文、字母、数字、下划线和连字符';
  return null;
}

function validatePassword(raw) {
  const p = String(raw || '');
  if (p.length < 6) return '密码至少需要 6 位';
  if (p.length > 32) return '密码最长 32 位';
  return null;
}

/* ============================================================
   Session
   ============================================================ */
function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    credits: row.credits,
    jackpot: row.jackpot,
    best: row.best,
    rounds: row.rounds,
    createdAt: row.created_at
  };
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now.toISOString(), exp.toISOString());
  return { token, expires: exp };
}

function sessionUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = db.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
  ).get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function destroySession(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function setSessionCookie(res, token, expires) {
  const maxAge = Math.floor((expires.getTime() - Date.now()) / 1000);
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

/* ============================================================
   防刷（内存计数器，重启清零）
   ============================================================ */
const rateBuckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + windowMs };
    rateBuckets.set(key, b);
  }
  b.count++;
  return b.count <= limit;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

/* ============================================================
   HTTP 工具
   ============================================================ */
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; }
    }
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (err) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extraHeaders || {}));
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/tiger2.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/* ============================================================
   API
   ============================================================ */
const userStmt = {
  byName: db.prepare('SELECT * FROM users WHERE username = ?'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  insert: db.prepare(
    'INSERT INTO users (username, password_hash, credits, jackpot, best, rounds, created_at, updated_at) VALUES (?, ?, 100, 8888, 100, 0, ?, ?)'
  ),
  update: db.prepare(
    'UPDATE users SET credits = ?, jackpot = ?, best = ?, rounds = ?, updated_at = ? WHERE id = ?'
  ),
  remove: db.prepare('DELETE FROM users WHERE id = ?')
};

function saveState(userId, patch) {
  const clamp = (v, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  const credits = clamp(patch.credits, 0, 1e9);
  const jackpot = clamp(patch.jackpot, 0, 1e9);
  const rounds = clamp(patch.rounds, 0, 1e7);
  if (credits == null || jackpot == null || rounds == null) return null;

  const row = userStmt.byId.get(userId);
  if (!row) return null;
  // 最高分只涨不跌，且服务端取 max(服务端记录, 客户端上报, 当前积分)
  const best = Math.max(row.best, credits, clamp(patch.best, 0, 1e9) ?? 0);

  userStmt.update.run(credits, jackpot, best, rounds, new Date().toISOString(), userId);
  return userStmt.byId.get(userId);
}

async function handleApi(req, res, pathname) {
  const ip = clientIp(req);

  // ---------- 注册 ----------
  if (pathname === '/api/register' && req.method === 'POST') {
    if (!rateLimit(`reg:${ip}`, 10, 60000)) {
      return sendJson(res, 429, { error: '操作过于频繁，请稍后再试' });
    }
    const body = await readBody(req);
    const nameErr = validateUsername(body.username);
    if (nameErr) return sendJson(res, 400, { error: nameErr });
    const pwErr = validatePassword(body.password);
    if (pwErr) return sendJson(res, 400, { error: pwErr });
    if (String(body.password) !== String(body.confirm || '')) {
      return sendJson(res, 400, { error: '两次输入的密码不一致' });
    }
    const username = String(body.username).trim();
    if (userStmt.byName.get(username)) {
      return sendJson(res, 409, { error: '该用户名已被注册，请更换' });
    }
    try {
      const info = userStmt.insert.run(username, hashPassword(body.password),
        new Date().toISOString(), new Date().toISOString());
      const user = userStmt.byId.get(Number(info.lastInsertRowid));
      const s = createSession(user.id);
      setSessionCookie(res, s.token, s.expires);
      return sendJson(res, 200, { user: publicUser(user) });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return sendJson(res, 409, { error: '该用户名已被注册，请更换' });
      }
      throw err;
    }
  }

  // ---------- 登录 ----------
  if (pathname === '/api/login' && req.method === 'POST') {
    if (!rateLimit(`login:${ip}`, 20, 60000)) {
      return sendJson(res, 429, { error: '尝试过于频繁，请稍后再试' });
    }
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) {
      return sendJson(res, 400, { error: '请输入用户名和密码' });
    }
    const user = userStmt.byName.get(username);
    // 统一错误文案，防止枚举已注册的用户名
    if (!user || !verifyPassword(password, user.password_hash)) {
      return sendJson(res, 401, { error: '用户名或密码错误' });
    }
    const s = createSession(user.id);
    setSessionCookie(res, s.token, s.expires);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  // ---------- 登出 ----------
  if (pathname === '/api/logout' && req.method === 'POST') {
    destroySession(req);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  // ---------- 当前身份 ----------
  if (pathname === '/api/me' && req.method === 'GET') {
    const user = sessionUser(req);
    if (!user) return sendJson(res, 401, { error: '未登录' });
    return sendJson(res, 200, { user: publicUser(user) });
  }

  // ---------- 保存游戏状态 ----------
  if (pathname === '/api/state' && req.method === 'POST') {
    const user = sessionUser(req);
    if (!user) return sendJson(res, 401, { error: '未登录' });
    if (!rateLimit(`state:${user.id}`, 30, 10000)) {
      return sendJson(res, 429, { error: '保存过于频繁' });
    }
    const body = await readBody(req);
    const saved = saveState(user.id, body);
    if (!saved) return sendJson(res, 400, { error: '数据不合法' });
    return sendJson(res, 200, { user: publicUser(saved) });
  }

  // ---------- 排行榜（全服，按最高分） ----------
  if (pathname === '/api/leaderboard' && req.method === 'GET') {
    const rows = db.prepare(
      'SELECT username, best, credits FROM users ORDER BY best DESC, credits DESC LIMIT 20'
    ).all();
    return sendJson(res, 200, {
      rank: rows.map(r => ({ name: r.username, best: r.best, credits: r.credits }))
    });
  }

  // ---------- 注销账号 ----------
  if (pathname === '/api/account/delete' && req.method === 'POST') {
    const user = sessionUser(req);
    if (!user) return sendJson(res, 401, { error: '未登录' });
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    userStmt.remove.run(user.id);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not found' });
}

/* ============================================================
   服务器
   ============================================================ */
const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (err) {
    console.error('[GoldenTiger] 请求处理失败:', err);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🐯  GoldenTiger · 金虎水果机');
  console.log(`  ➜  本机访问:  http://localhost:${PORT}`);
  console.log(`  ➜  数据文件:  ${path.join(DATA_DIR, 'golden-tiger.db')}`);
  console.log('  ➜  数据库:    SQLite（零依赖，随服务端自动创建）');
  console.log('');
});
