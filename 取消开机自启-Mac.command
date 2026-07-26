#!/bin/zsh
# 取消 KOL Campaign OS 开机自启（macOS），并停止当前后台实例。

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_LABEL="com.kol-campaign-os"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

clear
echo "KOL Campaign OS - Mac 取消开机自启"
echo ""

if [ -f "$PLIST_PATH" ]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "[OK] 已移除开机自启（$PLIST_PATH）"
else
  echo "[提示] 没有找到已注册的自启项，可能之前没有注册过。"
fi

# 停止正在运行的后台服务实例（只匹配本项目路径，不影响其他 node 进程）
if pkill -f "$PROJECT_DIR/server/index.js" 2>/dev/null; then
  echo "[OK] 已停止当前运行的工作台服务"
else
  echo "[提示] 当前没有正在运行的工作台服务"
fi

echo ""
echo "MySQL 容器仍在运行（由 Docker 管理）。如需一并停止，可在项目目录运行："
echo "  npm run db:down"
echo ""
read "?按回车关闭窗口..."
