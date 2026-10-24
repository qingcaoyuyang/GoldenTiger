# 🐯 GoldenTiger · 金虎水果机

老虎机玩法 H5 小游戏 + 标准账号系统 + 全服排行榜。

**零依赖**：只用 Node 内置模块（`node:http` + `node:sqlite` + `node:crypto`），不需要 `npm install`。

## 快速开始

```bash
# 要求 Node >= 22.5
node --experimental-sqlite server.js
# 或
npm start
```

打开 http://localhost:3000 即可玩。

换端口：`PORT=8080 node --experimental-sqlite server.js`

## 功能

### 游戏
- 24 格环形跑灯（顺时针，右上角起步）、8 种押注图案 + ×50 小特奖
- 大小竞猜（买大/买小）、加倍、收分
- 左右幸运格：横扫（灯光连扫多格）与连环（卡片逐个点亮）
- **七盏灯 + 彩池 + 拉杆**：命中大七七 / 小七七 / 大特奖 / 任意幸运格各点亮一盏；集满 7 盏后拉杆出现，拉下后三格滚轮随机停在大七七（彩池 1/4）/ 大特奖（1/2）/ 大虎头（全部）
- 彩池规则：每局启动时，玩家支付积分的一半进入彩池

### 账号
- 注册 / 登录 / 登出，用户名可用**手机号、邮箱或任意名称**（3-20 位，不可重复，大小写不敏感）
- 密码 scrypt 哈希 + 随机盐存储，恒定时间比较
- Session cookie（httpOnly / SameSite=Lax，7 天），**登出或过期后必须重新登录**
- 积分 / 彩池 / 最高分 / 局数服务端持久化，换设备登录不丢
- 全服排行榜（按最高分，取 Top 20）
- 账号注销接口（`POST /api/account/delete`）

### 操作技巧
- 双击押注区「大 / 小」标签：这一边 4 项快速押满 99；积分不够则平均分配
- 三击左 / 右幸运格：指定下一把落点（手机端没有键盘时的调试通道）

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/register` | 注册 `{username, password, confirm}`，成功即登录 |
| POST | `/api/login` | 登录 `{username, password}` |
| POST | `/api/logout` | 登出，销毁 session |
| GET | `/api/me` | 当前登录身份（无 session 返回 401） |
| POST | `/api/state` | 保存游戏状态 `{credits, jackpot, best, rounds}` |
| GET | `/api/leaderboard` | 全服排行榜 Top 20 |
| POST | `/api/account/delete` | 注销账号 |

## 数据

- SQLite 文件位于 `data/golden-tiger.db`（首次启动自动创建，**已在 .gitignore 中，不会入库**）
- 表结构：`users`（账号 + 积分）、`sessions`（登录会话）

## 目录结构

```
GoldenTiger/
├── server.js          # 服务端（零依赖）
├── package.json
├── public/
│   └── tiger2.html    # 游戏前端（单文件，图片全部内联）
└── data/              # 运行时生成 SQLite
```

## 安全说明

- 密码不明文存储（scrypt + 16 字节随机盐）
- 登录失败统一返回「用户名或密码错误」，防止枚举已注册用户名
- 注册 / 登录 / 存档接口有频率限制
- 最高分服务端只允许单调递增
- 生产部署建议置于 HTTPS 反向代理之后，并给 cookie 加 `Secure` 属性

## 已知边界（娱乐版本）

- 开奖在客户端计算、结果上报服务端存档。排行榜可防"改本地存储"，但防不了改接口请求。
  如需防刷榜，需把开奖逻辑搬到服务端（方案已设计，见项目内《老虎机-H5实现方案.md》）。
- 积分不可购买、不可兑换现实价值，纯娱乐。
