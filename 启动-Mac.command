#!/bin/zsh

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

clear
echo "KOL Campaign OS - Mac 启动器"
echo "项目位置：$PROJECT_DIR"
echo ""

if ! command -v npm >/dev/null 2>&1; then
  echo "没有检测到 Node.js / npm。"
  echo ""
  echo "请先安装 Node.js："
  echo "https://nodejs.org/"
  echo ""
  echo "安装完成后，再双击这个文件启动。"
  echo ""
  read "?按回车关闭窗口..."
  exit 1
fi

if [ ! -d "node_modules" ] || [ ! -d "server/node_modules" ] || [ ! -d "client/node_modules" ]; then
  echo "第一次启动，需要先安装依赖。这个过程可能需要几分钟。"
  echo ""
  npm run install-all
  echo ""
fi

echo "正在启动系统..."
echo ""
echo "启动成功后，请打开："
echo "http://localhost:3000"
echo ""
echo "如果要停止系统，直接关闭这个窗口，或按 Control + C。"
echo ""

npm run dev
