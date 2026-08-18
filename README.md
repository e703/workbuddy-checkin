# WorkBuddy 每日签到（Buddy加油站）

自动完成 WorkBuddy "Buddy加油站" 每日签到，领取积分。纯 API 调用，无 GUI 依赖，锁屏/息屏均可运行。

## 原理

WorkBuddy 桌面端登录后会在本地保存登录态，签到本质是对 `copilot.tencent.com` 的两个 HTTP 接口调用：

```
POST /v2/billing/meter/checkin-activity-status   # 查询今日是否已签到
POST /v2/billing/meter/daily-checkin             # 执行领取
```

脚本流程（幂等，重复运行不会重复领取）：

1. 读取登录态文件 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
2. 提取 `auth.accessToken` 和 `account.uid`（Bearer 认证）
3. 查询状态 → 未签到则领取 → 复核 → 输出结果与日志

签到入口在客户端的位置：左下角用户头像 → 弹层内"积分余额"上方的加油站入口。脚本无需任何界面操作。

## 使用

```bash
node scripts/api_checkin.mjs             # 完整签到（幂等，签到前随机延迟 5~35 分钟）
node scripts/api_checkin.mjs --status    # 只读查询今日状态（不延迟）
node scripts/api_checkin.mjs --no-jitter # 完整签到但跳过随机延迟
```

**随机延迟（防风控）**：定时任务在 00:05 固定触发后，脚本先随机等待 5~35 分钟再发起请求，每天的签到时刻各不相同，避免"每天准点签到"的机器特征。范围可用 `WORKBUDDY_JITTER_MIN_SEC` / `WORKBUDDY_JITTER_MAX_SEC` 调整（均设 0 关闭）；只读查询不延迟。

**客户端 UA（防风控）**：请求携带与桌面端一致的 User-Agent（`WorkBuddy/<版本> Chrome/... Electron/...`）。版本号动态解析自安装目录 `app.asar`，客户端升级后自动跟随；读不到时回退内置版本。可用 `WORKBUDDY_UA` 环境变量完全覆盖。

环境变量（可选）：`WORKBUDDY_API_BASE`（默认 `https://copilot.tencent.com`）、`WORKBUDDY_AUTH_FILE`（自定义登录态路径）、`WORKBUDDY_UA`（自定义 UA）。

退出码：`0` 成功或已签到 / `1` 脚本错误 / `2` 登录态失效 / `3` 网络异常 / `4` 业务错误。

## 定时任务

脚本跨平台（Windows / macOS / Linux 自动识别登录态路径）：

| 平台 | 登录态文件 | 定时机制 | 注册方式 |
|------|-----------|---------|---------|
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\...` | 任务计划程序（已注册 `WorkBuddyDailyCheckin`，每天 00:05） | `powershell -ExecutionPolicy Bypass -File scripts\create_task.ps1` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/...` | launchd（`com.alan.workbuddy-checkin`，每天 00:05） | `bash scripts/setup_launchd.sh install` |

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create_task.ps1   # （重新）注册
schtasks /Query /TN WorkBuddyDailyCheckin                          # 查看状态
schtasks /Run  /TN WorkBuddyDailyCheckin                           # 立即执行一次
Unregister-ScheduledTask WorkBuddyDailyCheckin                     # 卸载
```

配置要点：登录时运行即可（不依赖桌面）、电池供电也执行、错过 00:05 后开机会补跑（StartWhenAvailable）、超时上限 60 分钟（覆盖脚本内置 5~35 分钟随机延迟）。日志：`scripts\checkin.log`。

### macOS

```bash
brew install node                        # 前提：安装 Node 18+
bash scripts/setup_launchd.sh install    # 安装并加载 launchd 任务
bash scripts/setup_launchd.sh run        # 立即执行一次
bash scripts/setup_launchd.sh uninstall  # 卸载
```

前提：Mac 上已安装 WorkBuddy 桌面端并登录过（登录态按机器独立保存）。合盖睡眠错过的运行，唤醒后由 launchd 自动补跑。日志同样写入 `scripts\checkin.log`。

## 维护注意

1. **登录态有效期约 60 天**：过期后打开一次 WorkBuddy 桌面端即自动刷新，脚本会以退出码 `2` 提示。
2. **活动为限时活动**：Buddy加油站（2026-08-13 ~ 08-24，每日 100 积分）。活动结束后接口可能调整，脚本会以退出码 `4` 报错。
3. **接口为非公开内部 API**：来自 [SIMON-WORLD/workbuddy-daily-credit](https://github.com/SIMON-WORLD/workbuddy-daily-credit) 的逆向结论，可能随客户端版本变化；客户端大版本更新后用 `--status` 验证一次即可。
4. 本脚本仅读取本机登录态调用官方接口，请勿改造为多账号批量领取（有风控风险）。

## 历史方案（已废弃）

- 坐标点击版（checkin_py.py / checkin.ps1 / workbuddy_checkin.sh）：依赖 1920×1080 坐标模拟鼠标，UI 改版后失效，且锁屏下点击作用于锁屏桌面、静默失败。
- CDP 版（cdp_checkin.mjs）：Electron 远程调试端口 + DOM 点击，可锁屏运行，但签到入口移入活动页后定位困难，且需以调试参数重启 WorkBuddy。最终被纯 API 方案取代，已删除。

## 项目结构

```
workbuddy-checkin/
├── scripts/
│   ├── api_checkin.mjs     # 签到脚本（Node 18+，跨平台，无第三方依赖）
│   ├── create_task.ps1     # Windows 计划任务注册
│   ├── setup_launchd.sh    # macOS launchd 定时任务安装
│   └── checkin.log         # 运行日志
├── SKILL.md                # Agent 技能说明
└── README.md
```
