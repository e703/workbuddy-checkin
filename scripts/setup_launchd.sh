#!/bin/bash
# macOS: 安装/卸载 WorkBuddy 每日签到的 launchd 定时任务（每天 00:05）
# 用法:
#   bash setup_launchd.sh install    # 安装并加载
#   bash setup_launchd.sh uninstall  # 卸载
#   bash setup_launchd.sh run        # 立即跑一次
set -e

LABEL="com.workbuddy-checkin"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node || true)"
LOG="$SCRIPT_DIR/checkin.log"

if [ -z "$NODE_BIN" ]; then
  echo "[错误] 未找到 node。安装方式：brew install node，或从 nodejs.org 下载官方 darwin-x64 .pkg/.tar.xz（无 brew 的旧机器）" >&2
  exit 1
fi

install() {
  # 把安装时 shell 里已设置的 WORKBUDDY_* 环境变量固化进 plist（launchd 不会继承登录 shell 的环境）
  # 用途：mac 端静态钥不同(WORKBUDDY_STATIC_SECRET)、登录态文件路径不同(WORKBUDDY_AUTH_FILE)等
  ENV_BLOCK=""
  for name in WORKBUDDY_API_BASE WORKBUDDY_AUTH_FILE WORKBUDDY_UA WORKBUDDY_STATIC_SECRET WORKBUDDY_JITTER_MIN_SEC WORKBUDDY_JITTER_MAX_SEC; do
    eval "var=\"\${$name-}\""
    if [ -n "$var" ]; then
      ENV_BLOCK="$ENV_BLOCK
        <key>$name</key>
        <string>$var</string>"
    fi
  done
  # 若 Mac 合盖睡眠，00:05 错过的运行会在唤醒后由 launchd 补跑
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>EnvironmentVariables</key>
    <dict>$ENV_BLOCK
    </dict>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$SCRIPT_DIR/api_checkin.mjs</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>0</integer>
        <key>Minute</key>
        <integer>5</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "已安装: $PLIST (每天 00:05)"
  echo "日志:   $LOG"
}

uninstall() {
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已卸载: $PLIST"
}

run() {
  "$NODE_BIN" "$SCRIPT_DIR/api_checkin.mjs"
}

case "${1:-install}" in
  install)   install ;;
  uninstall) uninstall ;;
  run)       run ;;
  *) echo "用法: $0 [install|uninstall|run]"; exit 1 ;;
esac
