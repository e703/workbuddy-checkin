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
2. 提取 `auth.accessToken`（v5.6+ 为加密字段，脚本就地解密）和 `account.uid`（Bearer 认证）
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

环境变量（可选）：`WORKBUDDY_API_BASE`（默认 `https://copilot.tencent.com`）、`WORKBUDDY_AUTH_FILE`（自定义登录态路径）、`WORKBUDDY_UA`（自定义 UA）、`WORKBUDDY_STATIC_SECRET`（覆盖内置静态解密钥，mac 端钥不同时在 launchd 注入即可，无需改代码）。

退出码：`0` 成功或已签到 / `1` 脚本错误 / `2` 登录态失效 / `3` 网络异常 / `4` 业务错误。

## 定时任务

脚本跨平台（Windows / macOS / Linux 自动识别登录态路径）：

| 平台 | 登录态文件 | 定时机制 | 注册方式 |
|------|-----------|---------|---------|
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\...` | 任务计划程序（已注册 `WorkBuddyDailyCheckin`，每天 00:05） | `powershell -ExecutionPolicy Bypass -File scripts\create_task.ps1` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/...` | launchd（`com.workbuddy-checkin`，每天 00:05） | `bash scripts/setup_launchd.sh install` |

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create_task.ps1   # （重新）注册
schtasks /Query /TN WorkBuddyDailyCheckin                          # 查看状态
schtasks /Run  /TN WorkBuddyDailyCheckin                           # 立即执行一次
Unregister-ScheduledTask WorkBuddyDailyCheckin                     # 卸载
```

配置要点：登录时运行即可（不依赖桌面）、电池供电也执行、错过 00:05 后开机会补跑（StartWhenAvailable）、超时上限 60 分钟（覆盖脚本内置 5~35 分钟随机延迟）。日志：`scripts\checkin.log`。

### macOS

新机完整部署顺序：

```bash
# 1. 装 Node（见下方"安装 Node"三选一）
# 2. 拉项目并验证（--status 只读查询，不领取）
git clone https://github.com/e703/workbuddy-checkin.git
cd workbuddy-checkin
node scripts/api_checkin.mjs --status
# 3. 上一步返回 HTTP 200 后，安装定时任务（每天 00:05）
bash scripts/setup_launchd.sh install
```

`--status` 的结果决定第 3 步前是否需要额外操作：HTTP 200 = 两平台静态钥一致，直接部署；报"解密 accessToken 失败" = Mac 构建静态钥不同，按"维护注意 §5"在 Mac 上重新提取后再带环境变量安装；Mac 客户端为 v5.6 前旧版时登录态是明文，脚本自动兼容。

任务管理：

```bash
bash scripts/setup_launchd.sh run        # 立即执行一次（带随机延迟）
bash scripts/setup_launchd.sh uninstall  # 卸载
```

#### 安装 Node（三选一，无需第三方依赖）

- 有 brew：`brew install node`（Node 18+）
- 无 brew：用 nvm（macOS 12 Intel 可用，无需管理员权限）：

  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  \. "$HOME/.nvm/nvm.sh"      # 当前 shell 立即生效（或重启 Terminal）
  nvm install 22              # 下载的即官方 darwin-x64 二进制，Node 22 最低支持 macOS 10.15
  node -v                     # 应输出 v22.x.x
  ```

  注意：`raw.githubusercontent.com` 在国内网络可能连不上，失败可走代理重试，或改用下面的 .pkg 直装。
- 直装官方包：从 [nodejs.org](https://nodejs.org/) 下载 `darwin-x64` 安装包（.pkg，装到 `/usr/local/bin/node`；建议 22 LTS）。没有管理员权限则下载 .tar.xz 解压到用户目录，把 `bin` 加进 PATH 后再跑 `setup_launchd.sh`（脚本用 `command -v node` 定位，装在默认路径即可被找到）。

**重要**：`setup_launchd.sh install` 必须在能找到 node 的 shell 里执行（nvm 用户即 nvm 已加载的 shell）——launchd 执行时 PATH 只有系统路径，看不到 `~/.nvm`；但 install 时脚本会把 `command -v node` 解析出的**绝对路径**写进 plist，所以只要 install 那一刻 node 可见，定时任务就永远能找到。在没加载 nvm 的 shell 里跑 install 会直接报"未找到 node"，不会埋隐患。

安装 launchd 时，shell 里已设置的 `WORKBUDDY_*` 环境变量（如 `WORKBUDDY_STATIC_SECRET`、`WORKBUDDY_AUTH_FILE`）会被固化进 plist 的 `EnvironmentVariables`——launchd 不继承登录 shell 环境，所以 Mac 端专属配置必须在 install 时带上，例如：

```bash
WORKBUDDY_STATIC_SECRET=<mac端提取的静态钥> bash scripts/setup_launchd.sh install
```

前提：Mac 上已安装 WorkBuddy 桌面端并登录过（登录态按机器独立保存；系统版本装不上客户端时，可从 Windows 拷登录态文件并用 `WORKBUDDY_AUTH_FILE` 指向它，token 约 60 天过期后需回源机器重拷）。若旧版客户端（v5.6 前）登录态为明文字段，脚本自动兼容；v5.6+ 加密登录态的静态钥跨平台是否一致未验证，见"维护注意 §5"。合盖睡眠错过的运行，唤醒后由 launchd 自动补跑。日志同样写入 `scripts\checkin.log`。

## 维护注意

1. **登录态有效期约 60 天**：过期后打开一次 WorkBuddy 桌面端即自动刷新，脚本会以退出码 `2` 提示。
2. **活动为限时活动**：Buddy加油站（2026-08-13 起，每日 100 积分）。活动结束后接口可能调整，脚本会以退出码 `4` 报错。
3. **接口为非公开内部 API**：来自 [SIMON-WORLD/workbuddy-daily-credit](https://github.com/SIMON-WORLD/workbuddy-daily-credit) 的逆向结论，可能随客户端版本变化；客户端大版本更新后用 `--status` 验证一次即可。
4. 本脚本仅读取本机登录态调用官方接口，请勿改造为多账号批量领取（有风控风险）。
5. **客户端 v5.6+ 静态加密登录态**（2026-09-24 起生效）：`accessToken`/`nickname` 等字段变为 `{ $wbEncrypted: 1, envelope }` 加密对象。脚本内置编译期静态钥（`STATIC_SECRET`，与 envelope 中 keyId `9127dea1b44020a7` 配对）做 AES-256-GCM 就地解密，AAD 域为 `WB-AAD\0`、field 格式 `WBEV1`、scheme `sym-v1`。若客户端更换静态钥（脚本报"解密 accessToken 失败"），重新提取方法：

   1. 启动带主进程 inspector 的第二实例，断点拦在 app.asar 首行（防止二次实例被单实例锁退出）：
      - **Windows**：`WorkBuddy.exe --inspect-brk=127.0.0.1:9330`
      - **macOS**：`/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy --inspect-brk=127.0.0.1:9330`
   2. WebSocket 连 `http://127.0.0.1:9330/json/list` 返回的 `webSocketDebuggerUrl`，先 `Debugger.enable`，再 `Debugger.setBreakpointByUrl { lineNumber: 0, urlRegex: ".*app\\.asar.*" }`，然后 `Runtime.runIfWaitingForDebugger`；
   3. 断点命中后（`Debugger.paused` 事件）在 `callFrames[0]` 上 `Debugger.evaluateOnCallFrame` 执行 `require('electron').workbuddyStorage.loggerGet()`，返回 JSON 中的 `atRestSecretKey` 即新静态钥（注意：不能用裸 `Runtime.evaluate`——它落在无 `require`/`process` 的空上下文）；
   4. 更新脚本 `STATIC_SECRET`（或设环境变量 `WORKBUDDY_STATIC_SECRET`），并核对 `sha256(sha256(静态钥字符串)).hex 前 16 位` 与 keyblob（`~/.workbuddy/keyblob`）里 `slots[].protectorKeyId` 及 auth envelope 的 `keyId` 一致。

   **macOS 注意**：静态钥是编译期嵌入二进制的，Windows 与 macOS 为独立构建，**静态钥可能不同**。Mac 部署后先跑 `node scripts/api_checkin.mjs --status` 验证：200 即两平台同钥；报"解密 accessToken 失败"则按上述步骤在 Mac 上重新提取（inspector 流程跨平台一致），提取到的新钥通过 launchd 的 `EnvironmentVariables` 注入 `WORKBUDDY_STATIC_SECRET`，或直接改脚本常量。快捷预判：Mac 上 `~/.workbuddy/keyblob` 的 `protectorKeyId` 若同为 `9127dea1b44020a7`，则无需重提。

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
