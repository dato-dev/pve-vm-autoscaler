#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/pve-vm-autoscaler}"
ENV_DIR="${ENV_DIR:-/etc/pve-vm-autoscaler}"
SERVICE_NAME="${SERVICE_NAME:-pve-vm-autoscaler-agent}"
SOURCE_DIR="${SOURCE_DIR:-$(pwd)}"
NODE_MAJOR="${NODE_MAJOR:-22}"
MIN_NODE_MAJOR="${MIN_NODE_MAJOR:-20}"

AGENT_NODE_ID="${AGENT_NODE_ID:-$(hostname)}"
AGENT_SERVER_URL="${AGENT_SERVER_URL:-}"
AGENT_TOKEN="${AGENT_TOKEN:-}"
AGENT_INTERVAL_MS="${AGENT_INTERVAL_MS:-10000}"
AGENT_LABELS="${AGENT_LABELS:-role=worker,env=test}"
AGENT_MOUNT_POINT="${AGENT_MOUNT_POINT:-/}"

current_node_major() {
  if ! command -v node >/dev/null 2>&1; then
    echo 0
    return
  fi

  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

install_modern_node() {
  if ! command -v dnf >/dev/null 2>&1 && ! command -v yum >/dev/null 2>&1; then
    echo "Install Node.js ${MIN_NODE_MAJOR}+ and npm first." >&2
    exit 1
  fi

  if command -v dnf >/dev/null 2>&1; then
    dnf remove -y nodejs npm || true
    dnf module disable -y nodejs || true
    dnf install -y curl ca-certificates
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    dnf install -y nodejs
  else
    yum remove -y nodejs npm || true
    yum install -y curl ca-certificates
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    yum install -y nodejs
  fi
}

if [[ $EUID -ne 0 ]]; then
  echo "Run this script as root, for example: sudo $0" >&2
  exit 1
fi

if [[ -z "$AGENT_SERVER_URL" || -z "$AGENT_TOKEN" ]]; then
  echo "AGENT_SERVER_URL and AGENT_TOKEN are required." >&2
  echo "Example: sudo AGENT_SERVER_URL=http://192.168.1.10:8080 AGENT_TOKEN=change-me $0" >&2
  exit 1
fi

if [[ "$(current_node_major)" -lt "$MIN_NODE_MAJOR" ]]; then
  install_modern_node
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found in PATH." >&2
  exit 1
fi

if [[ "$(current_node_major)" -lt "$MIN_NODE_MAJOR" ]]; then
  echo "Node.js ${MIN_NODE_MAJOR}+ is required. Current version: $(node --version)" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$ENV_DIR"
tar \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude .env \
  --exclude '*.tsbuildinfo' \
  -C "$SOURCE_DIR" \
  -cf - . | tar -C "$INSTALL_DIR" -xf -

cd "$INSTALL_DIR"
unset NODE_OPTIONS

# husky ставит git-хуки и на целевой машине не нужен: каталог .git сюда не копируется,
# а без этого скрипт prepare падает и обрывает установку.
export HUSKY=0

# npm ci воспроизводим, но требует локфайл: если его нет, откатываемся на npm install.
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

# Кэш инкрементальной сборки мог приехать с машины разработчика через rsync или
# tar. Устаревший tsbuildinfo убеждает tsc, что всё уже собрано, и каталоги dist
# не создаются вовсе — установка падает на неразрешённых импортах рабочих пакетов.
# Чистим независимо от того, как файлы сюда попали.
find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete

# Собираем только агента и его зависимости, а не весь монорепозиторий: ошибка
# компиляции в серверном коде не должна мешать поставить агента на воркер.
npx tsc -b apps/agent

# Инструменты сборки на воркере больше не нужны и тянут за собой заметную часть
# уязвимостей из dev-цепочки. Оставляем только рантайм-зависимости агента.
npm prune --omit=dev

cat > "$ENV_DIR/agent.env" <<EOF
AGENT_NODE_ID=$AGENT_NODE_ID
AGENT_SERVER_URL=$AGENT_SERVER_URL
AGENT_TOKEN=$AGENT_TOKEN
AGENT_INTERVAL_MS=$AGENT_INTERVAL_MS
AGENT_LABELS=$AGENT_LABELS
AGENT_MOUNT_POINT=$AGENT_MOUNT_POINT
EOF
chmod 600 "$ENV_DIR/agent.env"

NODE_BIN="$(command -v node)"

cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Proxmox VE VM Autoscaler Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_DIR/agent.env
Environment=NODE_OPTIONS=
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/apps/agent/dist/index.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager
