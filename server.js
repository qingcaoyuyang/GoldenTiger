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

// 迁移：为已有 users 表补充 game_state 列（服务端权威状态）
{
  const cols = db.prepare("PRAGMA table_info(users)").all();
  if (!cols.some(c => c.name === 'game_state')){
    db.exec("ALTER TABLE users ADD COLUMN game_state TEXT");
    console.log('[GoldenTiger] 已为 users 表添加 game_state 列（旧账号首次登录时自动迁移）');
  }
  // dev_tools：该账号是否拥有测试通道（强制落点 L/R/J、三击幸运虎）
  if (!db.prepare("PRAGMA table_info(users)").all().some(c => c.name === 'dev_tools')){
    db.exec("ALTER TABLE users ADD COLUMN dev_tools INTEGER NOT NULL DEFAULT 0");
    console.log('[GoldenTiger] 已为 users 表添加 dev_tools 列（测试通道白名单）');
  }
}

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
    createdAt: row.created_at,
    devTools: !!row.dev_tools,         // 是否拥有测试通道（强制落点）
    state: loadGameState(row)          // 完整游戏状态（灯/押注/奖金/彩池/门禁）
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
    'INSERT INTO users (username, password_hash, credits, jackpot, best, rounds, game_state, created_at, updated_at) VALUES (?, ?, 100, 8888, 100, 0, ?, ?, ?)'
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

/* ============================================================
   游戏状态机（服务端权威）
   ------------------------------------------------------------
   所有游戏逻辑在服务端计算，客户端只负责演出。
   - 每用户一份完整状态（SQLite game_state 列，JSON）
   - 乐观锁 version：客户端每次操作带上自己看到的 version，
     不匹配即 409 并回传最新状态——多端无法分支、无法重放
   - phase 门禁：idle（可下注/旋转）/ gamble（可收分/加倍/竞猜）/ lever（只可拉杆）
   - 开奖、赔付、点灯、彩池、四位数重置全部服务端随机
   ============================================================ */
const PRIZES = [
  { id:'bar3',   name:'大特奖', mult:100 },
  { id:'seven',  name:'777',   mult:40 },
  { id:'star',   name:'星星',  mult:30 },
  { id:'melon',  name:'西瓜',  mult:25 },
  { id:'bell',   name:'铃铛',  mult:20 },
  { id:'lemon',  name:'柠檬',  mult:15 },
  { id:'orange', name:'橙子',  mult:10 },
  { id:'apple',  name:'苹果',  mult:5 }
];
const PRIZE = Object.fromEntries(PRIZES.map(p => [p.id, p]));
const BIG_IDS = ['bar3','seven','star','melon'];
const PATH_LEN = 24;
const JACKPOT_BASE = 8888;
const BET_MAX = 99;
const LAMP_GOAL = 7;
/* 新手保护：每 NEWBIE_EVERY 次启动保底一次幸运虎，累计 NEWBIE_LUCKY_TOTAL 次后恢复正常概率 */
const NEWBIE_EVERY = 5;
const NEWBIE_LUCKY_TOTAL = 6;
const POOL_SYMBOLS = [
  { key:'tiger', label:'大虎头', share: 1 },
  { key:'bar3',  label:'大特奖', share: .5 },
  { key:'seven', label:'大七七', share: .25 }
];

/* 环形布局：与客户端 SLOT_LAYOUT 一致（顺时针，右上角起步） */
const LUCKY_L = { lucky:'L' };
const LUCKY_R = { lucky:'R' };
const SLOT_LAYOUT = [
  { id:'lemon' },
  { id:'star', size:'small', boost:true }, { id:'star' }, LUCKY_R, { id:'apple' },
  { id:'bell', size:'small', boost:true }, { id:'orange' }, { id:'bell' },
  { id:'seven', size:'small', boost:true }, { id:'seven' },
  { id:'apple' }, { id:'apple', size:'small', boost:true },
  { id:'lemon' }, { id:'melon' }, { id:'melon', size:'small', boost:true },
  LUCKY_L, { id:'apple' },
  { id:'orange', size:'small', boost:true }, { id:'orange' },
  { id:'bell' },
  { id:'bar3', size:'small', special:50, name:'小特奖' }, { id:'bar3' },
  { id:'apple' },
  { id:'lemon', size:'small', boost:true }
];

function zeroBets(){ return Object.fromEntries(PRIZES.map(p => [p.id, 0])); }
function sumBets(bets){ return PRIZES.reduce((s, p) => s + (Math.floor(Number(bets?.[p.id]) || 0)), 0); }
function cloneBets(bets){
  return Object.fromEntries(PRIZES.map(p => [p.id, Math.max(0, Math.min(BET_MAX, Math.floor(Number(bets?.[p.id]) || 0)))]));
}
function multiplierFor(cfg){
  if (!cfg || cfg.lucky) return 0;
  if (cfg.special) return cfg.special;
  return cfg.size === 'small' ? 3 : (PRIZE[cfg.id]?.mult || 0);
}
function stripIndices(target, strip){
  const count = Math.max(1, strip || 1);
  const out = [];
  for (let k = 0; k < count; k++) out.push((target - k + PATH_LEN) % PATH_LEN);
  return out;
}
function cardStripIndices(target, strip){
  const count = Math.max(1, strip || 1);
  const out = [];
  for (let k = 0; k < count; k++) out.push((target - k + PRIZES.length) % PRIZES.length);
  return out;
}
function randInt(min, max){ return min + Math.floor(Math.random() * (max - min + 1)); }

function defaultGameState(){
  return {
    v: 1,
    credits: 100,
    jackpot: JACKPOT_BASE,
    lamps: 0,
    leverReady: false,
    bets: zeroBets(),
    lastBets: null,
    bonusWin: 0,
    canGamble: false,
    doubleUsed: false,
    best: 100,
    rounds: 0,
    phase: 'idle',           // idle | gamble | lever
    sinceLucky: 0,           // 距离下次保底幸运虎还差几次启动
    luckyCount: 6            // 已获得的幸运虎次数（>=6 表示新手保护已用完）
  };
}

/* 读取（必要时从旧列迁移）并消毒状态 */
function loadGameState(row){
  if (!row) return defaultGameState();
  let st = null;
  if (row.game_state){
    try { st = JSON.parse(row.game_state); } catch (e) { st = null; }
  }
  if (!st || typeof st !== 'object') st = defaultGameState();
  const d = defaultGameState();
  const clean = {
    ...d, ...st,
    bets: cloneBets(st.bets),
    lastBets: st.lastBets ? cloneBets(st.lastBets) : null,
    credits: Math.max(0, Math.min(1e9, Math.floor(Number(st.credits ?? d.credits)))),
    jackpot: Math.max(0, Math.min(1e9, Math.floor(Number(st.jackpot ?? d.jackpot)))),
    lamps: Math.max(0, Math.min(LAMP_GOAL, Math.floor(Number(st.lamps ?? 0)))),
    best: Math.max(0, Math.min(1e9, Math.floor(Number(st.best ?? d.best)))),
    rounds: Math.max(0, Math.floor(Number(st.rounds ?? 0))),
    bonusWin: Math.max(0, Math.min(1e9, Math.floor(Number(st.bonusWin ?? 0)))),
    doubleUsed: !!st.doubleUsed,
    canGamble: !!st.canGamble,
    leverReady: !!st.leverReady,
    sinceLucky: Math.max(0, Math.floor(Number(st.sinceLucky ?? 0))),
    luckyCount: Math.max(0, Math.floor(Number(st.luckyCount ?? NEWBIE_LUCKY_TOTAL))),
    v: Math.max(1, Math.floor(Number(st.v ?? 1)))
  };
  // phase 由门禁字段推导，防止脏数据
  clean.phase = clean.leverReady ? 'lever' : (clean.canGamble ? 'gamble' : 'idle');
  // 新手保护信息（派生，不入库）
  clean.newbie = {
    active: clean.luckyCount < NEWBIE_LUCKY_TOTAL,
    remaining: Math.max(0, NEWBIE_LUCKY_TOTAL - clean.luckyCount)
  };
  return clean;
}

function saveGameState(userId, state){
  const best = Math.max(state.best, state.credits);
  state.best = best;
  const { newbie, ...persist } = state;      // newbie 是派生信息，不入库
  db.prepare('UPDATE users SET game_state = ?, credits = ?, jackpot = ?, best = ?, rounds = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(persist), state.credits, state.jackpot, best, state.rounds, new Date().toISOString(), userId);
}

/* ============================================================
   测试通道开关
   ------------------------------------------------------------
   测试期：强制落点（L/R/J、三击幸运虎）对所有账号开放，默认开启。
   后期要改回「账号白名单制」：把环境变量设为 off 即可
     GT_DEV_TOOLS=off node --experimental-sqlite server.js
   ============================================================ */
const DEV_TOOLS_OPEN = (process.env.GT_DEV_TOOLS || 'on') !== 'off';

/* ============================================================
   Action 执行器：state -> { ok, state, result?, error? }
   ============================================================ */
function gameAction(st, action, payload = {}, ctx = {}){
  const S = st;
  const bump = () => { S.v = (S.v || 1) + 1; };

  // ---------- 下注 ----------
  if (action === 'bet'){
    if (S.phase !== 'idle') return { ok:false, error:'当前不能下注' };
    const id = String(payload.id || '');
    if (!PRIZE[id]) return { ok:false, error:'未知押注项' };
    const n = Math.floor(Number(payload.n || 1));
    if (!Number.isFinite(n) || n < 1) return { ok:false, error:'押注数量不合法' };
    const cur = S.bets[id] || 0;
    const add = Math.min(n, BET_MAX - cur, S.credits);
    if (add <= 0) return { ok:false, error: cur >= BET_MAX ? '该项已押满' : '积分不足' };
    S.credits -= add;
    S.bets[id] = cur + add;
    bump();
    return { ok:true, state:S, result:{ id, added:add } };
  }

  // ---------- 清空押注（退还） ----------
  if (action === 'clearBets'){
    if (S.phase !== 'idle') return { ok:false, error:'当前不能清空' };
    const total = sumBets(S.bets);
    if (!total) return { ok:true, state:S, result:{} };
    S.credits += total;
    S.bets = zeroBets();
    bump();
    return { ok:true, state:S, result:{ refund:total } };
  }

  // ---------- 重复上次押注 ----------
  if (action === 'repeatBets'){
    if (S.phase !== 'idle') return { ok:false, error:'当前不能重复押注' };
    const last = S.lastBets ? cloneBets(S.lastBets) : null;
    const total = last ? sumBets(last) : 0;
    if (!total) return { ok:false, error:'没有可重复的押注' };
    if (S.credits < total) return { ok:false, error:`积分不足，无法重复上一轮押注（需要 ${total} 分，当前 ${S.credits} 分）` };
    S.credits -= total;
    S.bets = last;
    bump();
    return { ok:true, state:S, result:{ total } };
  }

  // ---------- 快速押注（双击/长按 大/小） ----------
  if (action === 'quickBet'){
    if (S.phase !== 'idle') return { ok:false, error:'当前不能快速押注' };
    const ids = payload.group === 'big' ? BIG_IDS : PRIZES.filter(p => !BIG_IDS.includes(p.id)).map(p => p.id);
    if (payload.group !== 'big' && payload.group !== 'small') return { ok:false, error:'未知分组' };
    const cur = ids.map(id => S.bets[id] || 0);
    const need = cur.reduce((s, b) => s + (BET_MAX - b), 0);
    if (S.credits >= need){
      ids.forEach(id => { S.bets[id] = BET_MAX; });
      S.credits -= need;
    } else {
      const per = Math.floor(S.credits / ids.length);
      if (per <= 0) return { ok:false, error:'积分不足' };
      let spent = 0;
      ids.forEach((id, i) => {
        const target = Math.min(BET_MAX, cur[i] + per);
        S.bets[id] = target;
        spent += target - cur[i];
      });
      S.credits -= spent;
    }
    bump();
    return { ok:true, state:S, result:{ bets:cloneBets(S.bets) } };
  }

  // ---------- 旋转（服务端开奖） ----------
  if (action === 'spin'){
    let result_forced = null;
    if (S.phase !== 'idle') return { ok:false, error:'当前回合未结束' };
    if (S.leverReady) return { ok:false, error:'请先拉动拉杆领取超级奖励' };
    // 无押注时：复制上一轮的押注（延续上一次的压分模式）并扣除相应积分。
    // 上一轮的钱在上一轮已经扣过，这一轮是新的下注，所以这里要再扣一次。
    let total = sumBets(S.bets);
    if (total === 0){
      const last = S.lastBets ? cloneBets(S.lastBets) : null;
      const lastTotal = last ? sumBets(last) : 0;
      if (lastTotal > 0){
        if (S.credits < lastTotal){
          // 积分不足以支付上一轮押注 → 只能让玩家重新设计压分
          return { ok:false, error:`积分不足，无法继续上一轮押注（需要 ${lastTotal} 分，当前 ${S.credits} 分）` };
        }
        S.credits -= lastTotal;
        S.bets = last;
        total = lastTotal;
      } else {
        return { ok:false, error:'请先下注' };
      }
    }
    // 注意：普通路径下注时已扣过钱（bet action），这里绝不能重复扣
    const wagered = sumBets(S.bets);
    S.lastBets = cloneBets(S.bets);
    const poolAdd = Math.floor(wagered / 2);
    S.jackpot += poolAdd;
    S.bonusWin = 0;
    S.canGamble = false;
    S.rounds += 1;

    // 强制落点（测试通道）：测试期对所有账号开放。
    // 后期要收回白名单制时，把环境变量 GT_DEV_TOOLS=off 即可（无需改代码）。
    // 启动计数（新手保护进度）
    S.sinceLucky = (S.sinceLucky || 0) + 1;

    let target = randInt(0, PATH_LEN - 1);
    let guaranteed = false;
    const force = String((payload && payload.force) || '').toUpperCase();
    if (force && DEV_TOOLS_OPEN){
      const forced = { L: 15, R: 3, J: 9 }[force];
      if (forced != null){
        target = forced;
        result_forced = force;
      }
    } else if (S.luckyCount < NEWBIE_LUCKY_TOTAL && S.sinceLucky >= NEWBIE_EVERY){
      // 新手保护：每 5 次启动保底一次幸运虎（左/右随机），
      // 累计拿满 6 次幸运虎后恢复正常概率。
      target = randInt(0, 1) === 0 ? 15 : 3;
      guaranteed = true;
    }
    const cfg = SLOT_LAYOUT[target];
    // 命中幸运虎（自然或保底）→ 计数 +1、保底进度归零
    if (cfg.lucky){
      S.luckyCount = Math.min(NEWBIE_LUCKY_TOTAL, (S.luckyCount || 0) + 1);
      S.sinceLucky = 0;
    }
    let result;

    if (cfg.lucky === 'L'){
      // 左侧幸运格：灯光横扫
      const strip = randInt(3, 7);
      const sweep = randInt(0, PATH_LEN - 1);
      const indices = stripIndices(sweep, strip);
      const winners = [];
      let win = 0;
      indices.forEach(idx => {
        const c = SLOT_LAYOUT[idx];
        if (!c || c.lucky) return;
        const bet = S.lastBets[c.id] || 0;
        const mult = multiplierFor(c);
        if (bet > 0 && mult > 0){
          const amount = bet * mult;
          win += amount;
          winners.push({ idx, id:c.id, bet, mult, amount });
        }
      });
      if (S.lamps < LAMP_GOAL) S.lamps += 1;
      result = { kind:'grid', target, strip, sweep, winners, win };
      S.bonusWin = win;
      S.canGamble = win > 0;
    } else if (cfg.lucky === 'R'){
      // 右侧幸运格：五灯连环
      const chase = randInt(0, PRIZES.length - 1);
      const indices = cardStripIndices(chase, 5);
      const winners = [];
      let win = 0;
      indices.forEach(pi => {
        const prize = PRIZES[pi];
        const bet = S.lastBets[prize.id] || 0;
        if (bet > 0){
          const amount = bet * prize.mult;
          win += amount;
          winners.push({ card:pi, id:prize.id, bet, amount });
        }
      });
      if (S.lamps < LAMP_GOAL) S.lamps += 1;
      result = { kind:'card', target, chase, winners, win };
      S.bonusWin = win;
      S.canGamble = win > 0;
    } else {
      // 普通格
      const bet = S.lastBets[cfg.id] || 0;
      const mult = multiplierFor(cfg);
      const won = bet > 0 && mult > 0;
      const win = won ? bet * mult : 0;
      const isJackpot = cfg.id === 'seven' && cfg.size !== 'small';
      let lampLit = false;
      if (won && (cfg.special || (cfg.id === 'seven' && cfg.size === 'small') || isJackpot)){
        if (S.lamps < LAMP_GOAL){ S.lamps += 1; lampLit = true; }
      }
      result = { kind:'normal', target, won, win, mult, bet, isJackpot, lampLit, cfgId:cfg.id, size:cfg.size || null, special:cfg.special || null };
      S.bonusWin = win;
      S.canGamble = won;
    }

    // 结算尾态：本轮实际押注保存在 result.playedBets（演出期间显示用），
    // bets 清空表示"本轮已结算"——下次点启动会自动复制 lastBets 并再次扣分
    const playedBets = cloneBets(S.bets);
    S.bets = zeroBets();
    S.doubleUsed = false;
    if (S.lamps >= LAMP_GOAL && !S.leverReady){
      S.leverReady = true;                 // 灯满：拉杆就绪，全锁
    }
    S.phase = S.leverReady ? 'lever' : (S.canGamble ? 'gamble' : 'idle');
    bump();
    return { ok:true, state:S, result:{ ...result, playedBets, poolAdd, lampsAfter:S.lamps, leverReadyAfter:S.leverReady, forced: result_forced, guaranteed } };
  }

  // ---------- 收分 ----------
  if (action === 'collect'){
    if (!S.canGamble || S.bonusWin <= 0) return { ok:false, error:'没有可收取的奖金' };
    if (S.leverReady) return { ok:false, error:'请先拉动拉杆领取超级奖励' };
    const amount = S.bonusWin;
    S.credits += amount;
    S.bonusWin = 0;
    S.canGamble = false;
    S.doubleUsed = false;
    S.bets = zeroBets();
    S.phase = S.leverReady ? 'lever' : 'idle';
    bump();
    return { ok:true, state:S, result:{ amount } };
  }

  // ---------- 加倍 ----------
  if (action === 'double'){
    if (!S.canGamble || S.bonusWin <= 0) return { ok:false, error:'没有可加倍的奖金' };
    if (S.leverReady) return { ok:false, error:'请先拉动拉杆领取超级奖励' };
    if (S.doubleUsed) return { ok:false, error:'本次中奖已加倍' };
    if (S.credits < S.bonusWin) return { ok:false, error:'积分不足' };
    S.credits -= S.bonusWin;
    S.bonusWin *= 2;
    S.doubleUsed = true;
    bump();
    return { ok:true, state:S, result:{ cost:S.bonusWin / 2 } };
  }

  // ---------- 买大 / 买小 ----------
  if (action === 'gamble'){
    if (!S.canGamble || S.bonusWin <= 0) return { ok:false, error:'当前不能竞猜' };
    if (S.leverReady) return { ok:false, error:'请先拉动拉杆领取超级奖励' };
    const side = payload.side;
    if (side !== 'big' && side !== 'small') return { ok:false, error:'未知方向' };
    const roll = randInt(1, 12);
    const result = roll <= 6 ? 'small' : 'big';
    const win = side === result;
    if (win){
      S.bonusWin *= 2;
      S.doubleUsed = false;
      S.canGamble = true;
      S.phase = 'gamble';
    } else {
      S.bonusWin = 0;
      S.canGamble = false;
      S.doubleUsed = false;
      S.bets = zeroBets();
      S.phase = 'idle';
    }
    bump();
    return { ok:true, state:S, result:{ roll, outcome:result, win } };
  }

  // ---------- 拉杆（超级奖励） ----------
  if (action === 'lever'){
    if (!S.leverReady) return { ok:false, error:'拉杆未就绪' };
    const pick = randInt(0, POOL_SYMBOLS.length - 1);
    const sym = POOL_SYMBOLS[pick];
    const amount = Math.max(0, Math.floor(S.jackpot * sym.share));
    S.jackpot = Math.max(0, S.jackpot - amount);
    if (amount > 0) S.credits += amount;
    let resetDigits = null;
    if (sym.key === 'tiger'){
      // 大虎头掏空彩池 → 四位数随机重置（个位到千位）
      resetDigits = [randInt(0,9), randInt(0,9), randInt(0,9), randInt(0,9)];
      S.jackpot = Number(resetDigits.join(''));
    }
    S.lamps = 0;
    S.leverReady = false;
    S.phase = S.canGamble ? 'gamble' : 'idle';   // 有待收奖金则保留
    bump();
    return { ok:true, state:S, result:{ pick, label:sym.label, amount, poolCleared:sym.key === 'tiger', resetDigits } };
  }

  // ---------- 重置 ----------
  if (action === 'reset'){
    if (S.credits > 100) return { ok:false, error:'积分高于 100，不可重置' };
    const fresh = defaultGameState();
    fresh.v = (S.v || 1) + 1;
    fresh.best = Math.max(S.best, 100);
    return { ok:true, state:fresh, result:{} };
  }

  return { ok:false, error:'未知操作' };
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
      // 新账号写入新手保护状态：luckyCount=0 → 每 5 次启动保底一次幸运虎，累计 6 次
      const fresh = { ...defaultGameState(), luckyCount: 0, sinceLucky: 0 };
      const info = userStmt.insert.run(username, hashPassword(body.password), JSON.stringify(fresh),
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

  // ---------- 当前身份（含完整游戏状态） ----------
  if (pathname === '/api/me' && req.method === 'GET') {
    const user = sessionUser(req);
    if (!user) return sendJson(res, 401, { error: '未登录' });
    return sendJson(res, 200, { user: publicUser(user) });
  }

  // ---------- 游戏操作（服务端权威状态机） ----------
  if (pathname === '/api/game/action' && req.method === 'POST') {
    const user = sessionUser(req);
    if (!user) return sendJson(res, 401, { error: '未登录' });
    if (!rateLimit(`game:${user.id}`, 90, 10000)){
      return sendJson(res, 429, { error: '操作过于频繁' });
    }
    const body = await readBody(req);
    const action = String(body.action || '');
    const st = loadGameState(user);
    // 乐观锁：客户端必须基于最新 version 操作，否则拒绝并回传最新状态（防分支/防重放）
    // 例外：'bet' 是纯累加操作（credits -= n、bets[id] += n），基于最新服务端状态执行
    // 结果唯一、不会分叉，因此允许 version 落后时执行——否则「连续下注 + 期间其他操作」
    // 会因版本过期把玩家已下的注同步掉，表现为押注数字乱跳。
    const clientV = Math.floor(Number(body.v));
    const additive = action === 'bet';
    if (!additive && (!Number.isFinite(clientV) || clientV !== st.v)){
      return sendJson(res, 409, { error: '状态已更新，请同步', state: st });
    }
    const r = gameAction(st, action, body.payload || {}, { devTools: !!user.dev_tools });
    if (!r.ok){
      // 失败也持久化（部分 action 失败前无副作用，这里统一不写库）
      return sendJson(res, 400, { error: r.error, state: st });
    }
    saveGameState(user.id, r.state);
    return sendJson(res, 200, { ok: true, state: r.state, result: r.result || {} });
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
