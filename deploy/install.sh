#!/usr/bin/env bash
# deploy/install.sh — Instala/actualiza training-relay-vps en el VPS
# Uso:  sudo bash install.sh
set -euo pipefail

REPO_URL="https://github.com/elfich/training-relay-vps.git"
INSTALL_DIR="/opt/orus-training-relay"
SERVICE_NAME="training-relay"
SERVICE_USER="orus"
NGINX_SNIPPET="/etc/nginx/snippets/training-relay.conf"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[+]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
die()     { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Ejecuta como root: sudo bash $0"

# ── 1. Node.js ────────────────────────────────────────────────────────────────
if command -v node &>/dev/null && node -e "process.exit(parseInt(process.versions.node)>=18?0:1)" 2>/dev/null; then
    info "Node.js $(node --version) ya instalado"
else
    info "Instalando Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

# ── 2. Usuario del servicio ───────────────────────────────────────────────────
if id "$SERVICE_USER" &>/dev/null; then
    info "Usuario '$SERVICE_USER' ya existe"
else
    info "Creando usuario '$SERVICE_USER'..."
    useradd -r -s /usr/sbin/nologin "$SERVICE_USER"
fi

# ── 3. Directorio de instalación ─────────────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Actualizando repo en $INSTALL_DIR..."
    sudo -u "$SERVICE_USER" git -C "$INSTALL_DIR" pull --ff-only
else
    info "Clonando repo en $INSTALL_DIR..."
    mkdir -p "$INSTALL_DIR"
    chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
    sudo -u "$SERVICE_USER" git clone "$REPO_URL" "$INSTALL_DIR"
fi

# ── 4. Dependencias npm ───────────────────────────────────────────────────────
info "Instalando dependencias npm..."
sudo -u "$SERVICE_USER" npm --prefix "$INSTALL_DIR" install --omit=dev --silent

# ── 5. Servicio systemd ───────────────────────────────────────────────────────
info "Instalando servicio systemd..."
cp "$INSTALL_DIR/deploy/training-relay.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

if systemctl is-active --quiet "$SERVICE_NAME"; then
    info "Reiniciando servicio..."
    systemctl restart "$SERVICE_NAME"
else
    info "Arrancando servicio..."
    systemctl start "$SERVICE_NAME"
fi
systemctl is-active --quiet "$SERVICE_NAME" && info "Servicio activo ✓" || die "El servicio no arrancó"

# ── 6. Snippet nginx ──────────────────────────────────────────────────────────
info "Instalando snippet nginx en $NGINX_SNIPPET..."
mkdir -p /etc/nginx/snippets
cp "$INSTALL_DIR/deploy/nginx.conf" "$NGINX_SNIPPET"

echo ""
warn "──────────────────────────────────────────────────────"
warn "Añade esta línea dentro del bloque server{} de tu vhost HTTPS:"
warn ""
warn "    include snippets/training-relay.conf;"
warn ""
warn "Luego ejecuta: nginx -t && systemctl reload nginx"
warn "──────────────────────────────────────────────────────"
echo ""
info "Instalación completada."
info "Verifica: curl http://127.0.0.1:8766/api/training/requests"
