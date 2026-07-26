#!/bin/zsh
# 注册 KOL Campaign OS 开机自启（macOS，launchd LaunchAgent）。
# 双击运行一次即可：之后每次登录 Mac 都会自动在后台启动工作台，
# 浏览器直接打开 http://localhost:5001 使用。

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_LABEL="com.kol-campaign-os"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
SERVICE_SCRIPT="$PROJECT_DIR/scripts/start-service-mac.sh"

clear
echo "KOL Campaign OS - Mac 开机自启注册"
echo "项目位置：$PROJECT_DIR"
echo ""

# 前置检查
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 没有检测到 Node.js。请先安装：https://nodejs.org/"
  read "?按回车关闭窗口..."
  exit 1
fi
echo "[OK] Node.js: $(command -v node) ($(node -v))"

if ! command -v docker >/dev/null 2>&1; then
  echo "[错误] 没有检测到 docker 命令。请先安装 Docker Desktop，"
  echo "      并在其设置中勾选 Start Docker Desktop when you sign in。"
  read "?按回车关闭窗口..."
  exit 1
fi
echo "[OK] Docker: $(command -v docker)"

if [ ! -f "$PROJECT_DIR/client/build/index.html" ]; then
  echo "[错误] 缺少前端构建产物 client/build/index.html。"
  echo "      请先在项目目录运行一次：npm run build"
  read "?按回车关闭窗口..."
  exit 1
fi
echo "[OK] 前端构建产物存在"

chmod +x "$SERVICE_SCRIPT"

# 写入 LaunchAgent plist
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$SERVICE_SCRIPT</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
</dict>
</plist>
EOF
echo "[OK] 已写入 $PLIST_PATH"

# 重新加载 LaunchAgent（会先停掉旧实例）
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load -w "$PLIST_PATH"
echo "[OK] LaunchAgent 已加载并立即启动"

echo ""
echo "完成！现在起每次登录 Mac 都会自动启动工作台。"
echo ""
echo "  你的书签：http://localhost:5001"
echo "  运行日志：$PROJECT_DIR/logs/"
echo "  取消自启：双击 取消开机自启-Mac.command"
echo ""
echo "提示：如果电脑进入睡眠，链接会暂时打不开，建议关闭自动睡眠。"
echo "提示：前端代码更新后需要运行一次 npm run build 才会生效。"
echo ""
read "?按回车关闭窗口..."
