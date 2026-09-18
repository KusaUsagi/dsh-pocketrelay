#!/usr/bin/env bash
# dsh-pocketrelay relay 在线更新（服务器无 git pull 时用：把 tar + 本脚本 SCP 进来，跑一条命令）。
#
# 用法：
#   # 桌面侧打包（已在 repo 根执行过）：
#   #   pnpm --filter @dsh-pocketrelay/relay-server build
#   #   tar -czf relay-dist-0.2.0.tar.gz -C packages/relay-server dist
#   scp packages/relay-server/relay-dist-0.2.0.tar.gz <server>:/tmp/
#   scp packages/relay-server/deploy/update.sh        <server>:/tmp/
#   ssh <server> 'sudo bash /tmp/update.sh /tmp/relay-dist-0.2.0.tar.gz'
#
# 环境变量：
#   RELAY_DIR  dist 所在的 relay-server 包目录（默认 /opt/dsh-pocketrelay；若你的布局是
#              仓库根放在 /opt/dsh-pocketrelay，则设为 /opt/dsh-pocketrelay/packages/relay-server）。
#   SERVICE    systemd 单元名（默认 dsh-pocketrelay）。
#   DSH_POCKETRELAY_PORT  烟雾测试端口（默认 8443）。
#
# 协议包 @dsh-pocketrelay/protocol 的 dist 冻结不动（本脚本只换 relay-server 的 dist）。
set -euo pipefail

TAR="${1:-/tmp/relay-dist-0.2.0.tar.gz}"
RELAY_DIR="${RELAY_DIR:-/opt/dsh-pocketrelay}"
SERVICE="${SERVICE:-dsh-pocketrelay}"
PORT="${DSH_POCKETRELAY_PORT:-8443}"
DIST="$RELAY_DIR/dist"

if [ "$(id -u)" -ne 0 ]; then echo "需要 root（systemd）" >&2; exit 1; fi
if [ ! -f "$TAR" ]; then echo "找不到 tar：$TAR（用法：sudo bash $0 <path-to-tar>）" >&2; exit 1; fi
if [ ! -d "$DIST" ]; then
  echo "找不到 dist 目录：$DIST" >&2
  echo "→ 设 RELAY_DIR 指向 relay-server 包目录（含 dist/ 的那一层）。" >&2
  echo "→ 例如：sudo RELAY_DIR=/opt/dsh-pocketrelay/packages/relay-server bash $0 $TAR" >&2
  exit 1
fi

TS=$(date +%s)
BAK="$DIST.bak.$TS"

echo "→ 停 $SERVICE"
systemctl stop "$SERVICE" || true

echo "→ 备份旧 dist → $BAK"
cp -r "$DIST" "$BAK"

echo "→ 解包新 dist（覆盖）"
rm -rf "$DIST"
mkdir -p "$DIST"
# tar 顶层是 dist/，剥一层落到 $DIST 根。
tar xzf "$TAR" -C "$DIST" --strip-components=1

echo "→ 清理已废弃的 http-proxy.*（0.2.0 不再有；tar 已不含，双保险）"
rm -f "$DIST"/http-proxy.* 2>/dev/null || true

echo "→ 启 $SERVICE"
systemctl start "$SERVICE"
sleep 1

if ! systemctl is-active --quiet "$SERVICE"; then
  echo "✗ $SERVICE 启动失败，自动回滚到 $BAK" >&2
  rm -rf "$DIST"
  mv "$BAK" "$DIST"
  systemctl start "$SERVICE" || true
  echo "→ 已回滚。查日志：journalctl -u $SERVICE -n 50 --no-pager" >&2
  exit 1
fi

echo "✓ $SERVICE 已启动"
echo "→ 烟雾测试（期望：401 / 200 / 200）"
curl -kfsS -o /dev/null -w "  GET /api/sessions (无 cookie) → %{http_code} (期 401)\n" "https://127.0.0.1:$PORT/api/sessions" || true
curl -kfsS -o /dev/null -w "  GET / (未配对)            → %{http_code} (期 200)\n" "https://127.0.0.1:$PORT/"        || true
curl -kfsS -o /dev/null -w "  GET /pair                → %{http_code} (期 200)\n" "https://127.0.0.1:$PORT/pair"    || true

echo
echo "完成。回滚命令（如需）：sudo rm -rf $DIST && sudo mv $BAK $DIST && sudo systemctl restart $SERVICE"
echo "查日志：journalctl -u $SERVICE -f"
