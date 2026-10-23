#!/bin/zsh
unsetopt BG_NICE
cd -- "$(dirname -- "$0")" || exit 1

node_bin="$(command -v node 2>/dev/null)"
if [[ -z "$node_bin" && -x /opt/homebrew/bin/node ]]; then node_bin=/opt/homebrew/bin/node; fi
if [[ -z "$node_bin" && -x /usr/local/bin/node ]]; then node_bin=/usr/local/bin/node; fi
if [[ -z "$node_bin" ]]; then
  echo "没有找到 Node.js。请先安装 Node.js 24.12 或更新版本。"
  read -r "reply?按回车键关闭窗口..."
  exit 1
fi

current_service="$(curl -fsS --max-time 2 http://127.0.0.1:3000/api/capabilities 2>/dev/null)"
if [[ "$current_service" == *'"version":"0.5.3"'* && "$current_service" == *LOCAL_DEMO_ONLY* ]]; then
  open http://127.0.0.1:3000/
  echo "校园快取通已在浏览器中打开。"
  exit 0
fi
if [[ -n "$current_service" ]]; then
  echo "3000 端口已有其他版本的服务。请先关闭旧版终端窗口，再重新双击此文件。"
  read -r "reply?按回车键关闭窗口..."
  exit 1
fi

echo "正在启动校园快取通本机演示..."
"$node_bin" server/index.mjs &
server_pid=$!
sleep 1

if [[ "$(curl -fsS --max-time 2 http://127.0.0.1:3000/api/capabilities 2>/dev/null)" != *'"version":"0.5.3"'* ]]; then
  echo "启动失败，请确认 3000 端口未被其他程序占用。"
  read -r "reply?按回车键关闭窗口..."
  exit 1
fi

open http://127.0.0.1:3000/
echo "浏览器已打开。保持此终端窗口运行；关闭窗口即可停止本机演示。"
wait $server_pid
