#!/usr/bin/env bash
# dsh-pocketrelay relay 部署脚本（腾讯云 Linux，公网 IP + 自签证书）。
# 用法：sudo DSH_POCKETRELAY_HOST_TOKEN=xxx bash packages/relay-server/deploy/install.sh
# 可选：DSH_POCKETRELAY_PORT / DSH_POCKETRELAY_DATA_DIR / DSH_POCKETRELAY_ADMIN_PASSWORD
set -euo pipefail

DATA_DIR="${DSH_POCKETRELAY_DATA_DIR:-/var/lib/dsh-pocketrelay}"
HOST_TOKEN="${DSH_POCKETRELAY_HOST_TOKEN:-}"
PORT="${DSH_POCKETRELAY_PORT:-8443}"
ADMIN_PW="${DSH_POCKETRELAY_ADMIN_PASSWORD:-}"
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)" # 项目根

if [ "$(id -u)" -ne 0 ]; then echo "需要 root（systemd）" >&2; exit 1; fi

# 1. Node >= 22
if ! command -v node >/dev/null 2>&1; then
  echo "未安装 Node。安装 Node 22 后重试：https://github.com/nodesource/distributions" >&2
  exit 1
fi
if ! node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"; then
  echo "需要 Node >= 22（当前 $(node -v)）" >&2
  exit 1
fi
command -v pnpm >/dev/null 2>&1 || npm install -g pnpm

# 2. 构建
cd "$REPO_DIR"
pnpm install --frozen-lockfile
pnpm --filter @dsh-pocketrelay/protocol build
pnpm --filter @dsh-pocketrelay/relay-server build

# 3. 自签证书（openssl 预生成；运行时 selfsigned 亦可自动生成并缓存到同目录）
mkdir -p "$DATA_DIR/tls"
if [ ! -f "$DATA_DIR/tls/cert.pem" ] || [ ! -f "$DATA_DIR/tls/key.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout "$DATA_DIR/tls/key.pem" -out "$DATA_DIR/tls/cert.pem" \
    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
  chmod 600 "$DATA_DIR/tls/key.pem"
fi

# 4. systemd unit
if [ -z "$HOST_TOKEN" ]; then echo "需要 DSH_POCKETRELAY_HOST_TOKEN" >&2; exit 1; fi
NODE_BIN="$(command -v node)"
cat > /etc/systemd/system/dsh-pocketrelay.service <<UNIT
[Unit]
Description=dsh-pocketrelay relay
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR/packages/relay-server
Environment=DSH_POCKETRELAY_HOST_TOKEN=$HOST_TOKEN
ExecStart=$NODE_BIN dist/cli.js --port $PORT --dataDir $DATA_DIR --cert $DATA_DIR/tls/cert.pem --key $DATA_DIR/tls/key.pem ${ADMIN_PW:+--adminPassword $ADMIN_PW}
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now dsh-pocketrelay
echo "dsh-pocketrelay 已启动：https://0.0.0.0:$PORT  数据目录 $DATA_DIR"
[ -n "$ADMIN_PW" ] && echo "管理口令：$ADMIN_PW"
echo "查看日志：journalctl -u dsh-pocketrelay -f"
