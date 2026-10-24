# CHANGELOG

本仓库版本日志。规则：每轮迭代一个版本（SemVer），完整设计与实测记录见项目内 `tiger2-复盘.md`。
发布状态说明：🚀 已发布到 https://tiger.gesichen.top ｜ 📦 仅 GitHub ｜ 🧪 测试中

## [1.1.0] - 2026-10-24 🚀

### Added
- 线上部署：Azure VM（40.83.90.104）+ systemd 双服务常驻（goldentiger / cloudflared-goldentiger）
- Cloudflare Tunnel 接入 tiger.gesichen.top（出站连接，服务器不开入站端口）
- `deploy.sh` 一键发布脚本（同步代码 → 重启服务 → 健康检查）

### Changed
- 默认端口 3000 → 3100（避开服务器上已有的 docker 服务占用）
- README 增加「线上部署」章节（架构图 + 复现步骤）

## [1.0.0] - 2026-10-24 🚀

### Added
- **账号系统**：注册 / 登录 / 登出；用户名支持手机号、邮箱、任意名称（3-20 位，不可重复，大小写不敏感）；密码 scrypt + 随机盐；httpOnly session cookie（7 天）；登出即失效
- **服务端持久化**：积分 / 彩池 / 最高分 / 局数存 SQLite（node:sqlite，零依赖）；最高分服务端只涨不跌
- **全服排行榜**：按最高分 Top 20，登录门与账号面板均可查看
- **安全**：登录失败统一文案防枚举；注册/登录 IP 限频、存档用户限频；账号注销接口
- 前端登录门：登录 / 注册双 Tab，密码 + 确认密码校验

### Technical
- 服务端零依赖：Node 原生 `node:http` + `node:sqlite` + `node:crypto`，Node ≥ 22.5 直接跑，无需 npm install
- 前端 `Store`（localStorage）→ `api` 适配器，游戏逻辑零改动

### Verified
- API 全用例（注册查重/密码校验/session/登出/排行榜/状态保存）
- 端到端（注册→玩→刷新保登录→登出→重登积分不丢）
- 五种尺寸无溢出、全流程无 JS 异常
