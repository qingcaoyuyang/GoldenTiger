#!/usr/bin/env node
/**
 * 测试通道开关：给指定账号开启/关闭「强制落点」能力
 *   开启后：电脑按 L/R/J、手机三击幸运虎，可以指定下一把落点
 *   关闭后：这两个操作无效，落点仍由服务端随机
 *
 * 用法：
 *   node --experimental-sqlite tools/set-dev.cjs <用户名> [on|off]
 *   node --experimental-sqlite tools/set-dev.cjs --list
 */
'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'golden-tiger.db'));
const args = process.argv.slice(2);

if (!args.length || args[0] === '--list') {
  const rows = db.prepare('SELECT id, username, dev_tools, best FROM users ORDER BY id').all();
  console.log('用户名'.padEnd(20) + '测试通道'.padEnd(10) + '最高分');
  for (const r of rows) {
    console.log(String(r.username).padEnd(20) + (r.dev_tools ? '已开启' : '关闭').padEnd(10) + r.best);
  }
  process.exit(0);
}

const name = args[0];
const on = (args[1] || 'on') === 'on';
const row = db.prepare('SELECT id, username FROM users WHERE username = ?').get(name);
if (!row) {
  console.error('账号不存在：' + name);
  process.exit(1);
}
db.prepare('UPDATE users SET dev_tools = ? WHERE id = ?').run(on ? 1 : 0, row.id);
console.log(`${row.username} 的测试通道已${on ? '开启' : '关闭'}`);
