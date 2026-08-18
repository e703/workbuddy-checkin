#!/bin/bash
# macOS: 安装/卸载 WorkBuddy 每日签到的 launchd 定时任务（每天 00:05）
# 用法:
#   bash setup_launchd.sh install    # 安装并加载
#   bash setup_launchd.sh uninstall  # 卸载
#   bash setup_launchd.sh run        # 立即跑一次
set -e

LABEL="com.alan.workbuddy-checkin"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node || true)"
LOG="$SCRIPT_DIR/checkin.log"

if [ -z "$NODE_BIN" ]; then
  echo "[错误] 未找到 node，请先安装 Node.js (brew install node)" >&2
  exit 1
fi

install() {
  # 若 Mac 合盖睡眠，00:05 错过的运行会在唤醒后由 launchd 补跑
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
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
