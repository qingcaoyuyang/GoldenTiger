#!/bin/bash
# ============================================================
# GoldenTiger 一键发布到 Azure
# 用法：./deploy.sh
# 流程：同步代码 → 重启服务 → 健康检查
# 前置：本机 SSH key 已授权 azureuser@40.83.90.104
# ============================================================
set -euo pipefail

SERVER="azureuser@40.83.90.104"
REMOTE_DIR="~/goldentiger"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10"

echo "==> [1/4] 同步代码到 Azure（排除 .git / data / node_modules）"
rsync -az --delete \
  --exclude '.git' --exclude 'data' --exclude 'node_modules' \
  -e "$SSH" \
  "$LOCAL_DIR/" "$SERVER:$REMOTE_DIR/"

echo "==> [2/4] 重启 goldentiger 服务"
$SSH "$SERVER" "sudo systemctl restart goldentiger && sleep 2 && systemctl is-active goldentiger"

echo "==> [3/4] 健康检查"
code=$(curl -sS --noproxy '*' -m 10 -o /dev/null -w '%{http_code}' https://tiger.gesichen.top/ || echo 000)
if [ "$code" = "200" ]; then
  echo "    https://tiger.gesichen.top -> 200 OK"
else
  echo "    !! 健康检查失败（HTTP $code），请检查服务器日志："
  echo "       ssh $SERVER 'sudo journalctl -u goldentiger -n 30 --no-pager'"
  exit 1
fi

echo "==> [4/4] 完成 ✅ 已发布到 https://tiger.gesichen.top"
