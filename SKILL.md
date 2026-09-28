---
name: workbuddy-checkin
description: 当用户想要完成 WorkBuddy 每日签到（Buddy加油站活动，领取每日积分）时使用此技能。通过读取 WorkBuddy 桌面端本地登录态文件，直接调用 copilot.tencent.com 签到 API 完成领取，纯 HTTP 调用无 GUI 依赖，锁屏可运行。触发关键词包括"签到"、"WorkBuddy签到"、"每日签到"、"打卡积分"、"加油站"等。
---

# WorkBuddy 每日签到技能

## 概述

自动化执行 WorkBuddy "Buddy加油站" 每日签到。通过读取本地登录态并直接调用签到 API 完成，不模拟任何界面操作。

## 执行方法

```bash
node "C:\Sources\workbuddy-checkin\scripts\api_checkin.mjs"            # 完整签到（幂等）
node "C:\Sources\workbuddy-checkin\scripts\api_checkin.mjs" --status   # 只读查询
```

退出码：`0` 成功或已签到 / `2` 登录态失效 / `3` 网络异常 / `4` 业务错误（接口变更或活动结束）。

## 技术要点

- 登录态文件：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`，取 `auth.accessToken`（Bearer）与 `account.uid`
- **v5.6+ 静态加密**：accessToken/nickname 等敏感字段为 `{ $wbEncrypted: 1, envelope }` 加密对象，脚本用编译期静态钥（sha256 后作 AES-256-GCM key，AAD 域 `WB-AAD\0`）就地解密；静态钥变更时按 README 维护注意重新提取
- API：`POST https://copilot.tencent.com/v2/billing/meter/checkin-activity-status`（查询）与 `/v2/billing/meter/daily-checkin`（领取），body 为 `{"uid": ...}`
- 状态字段：`data.today_checked_in`（是否已签）、`streak_days`（连续天数）、`theme_name`（活动名）
- 流程幂等：先查状态，已签跳过，未签才领，领后复核
- 需 Node 18+，无第三方依赖；运行日志：`scripts\checkin.log`

## 定时任务

已注册 `WorkBuddyDailyCheckin`（每天 00:05，StartWhenAvailable 错过补跑）。重新注册：`powershell -ExecutionPolicy Bypass -File scripts\create_task.ps1`。

## 故障排除

| 现象 | 处理 |
|------|------|
| 退出码 2 | 登录态过期：打开一次 WorkBuddy 桌面端自动刷新（约 60 天过期一次） |
| 退出码 4 | 接口变更或活动结束（Buddy加油站为限时活动）：用 `--status` 验证，必要时重新逆向接口 |
| 退出码 3 | 网络问题，稍后重试 |
| 日志报"解密 accessToken 失败" | 客户端更换了静态钥：按 README"维护注意 §5"重新提取并更新脚本内 `STATIC_SECRET` |

## 注意

勿改造为多账号批量领取（风控风险）。接口为非公开内部 API，源自 github.com/SIMON-WORLD/workbuddy-daily-credit 的逆向。
