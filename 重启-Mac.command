#!/bin/zsh
# 重启 KOL Campaign OS 后台服务（macOS，launchd LaunchAgent）。
# 双击运行：会先停掉当前实例再立即拉起，MySQL 容器不受影响。

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_LABEL="com.kol-campaign-os"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

clear
echo "KOL Campaign OS - Mac 重启"
echo ""

if [ ! -f "$PLIST_PATH" ]; then
  echo "[错误] 没有注册开机自启，无法以后台方式重启。"
  echo "      请先双击 注册开机自启-Mac.command。"
  echo ""
  read "?按回车关闭窗口..."
  exit 1
fi

# kickstart -k：先停掉当前实例再立即拉起
if launchctl kickstart -k "gui/$(id -u)/$PLIST_LABEL"; then
  echo "[OK] 服务已重启"
else
  echo "[错误] 重启失败，可尝试双击 注册开机自启-Mac.command 重新加载。"
  echo ""
  read "?按回车关闭窗口..."
  exit 1
fi

# 等服务真正起来（最多 ~1 分钟）
TRIES=0
until curl -s -o /dev/null http://localhost:5001/; do
  TRIES=$((TRIES + 1))
  if [ "$TRIES" -ge 20 ]; then
    echo "[警告] 服务尚未响应，请查看日志：$PROJECT_DIR/logs/"
    echo ""
    read "?按回车关闭窗口..."
    exit 1
  fi
  sleep 3
done

echo "[OK] 工作台已就绪：http://localhost:5001"
echo ""
read "?按回车关闭窗口..."
