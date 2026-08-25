#!/usr/bin/env bash
#
# Installs Remnawave Panel (backend + Postgres + Redis) and a Caddy reverse
# proxy in front of it on a fresh Ubuntu/Debian server. This is the "main
# server" from the project's architecture (main server <-> nodes): all
# business logic lives here, nodes only run Xray via Remnawave Node.
#
# This script is a thin wrapper around Remnawave's own official install
# steps (https://github.com/remnawave/panel/blob/main/docs/install) — it
# does not reimplement Remnawave, it just automates the documented
# docker-compose + .env + Caddy setup end to end.
#
# Usage:
#   sudo PANEL_DOMAIN=panel.example.com bash scripts/install-main-server.sh
#
# Re-running is safe: if Remnawave is already configured (.env exists), the
# script skips secret generation and just makes sure the stack is up.
#
# To wipe everything and start over (fresh Postgres, fresh secrets, fresh
# bootstrap prompts — e.g. while iterating during setup), set RESET_INSTALL:
#   sudo RESET_INSTALL=1 PANEL_DOMAIN=panel.example.com bash scripts/install-main-server.sh
# This asks for a typed confirmation (see confirm_or_die in lib/common.sh)
# before touching anything. It does NOT wipe Caddy's SSL certificate cache,
# to avoid hitting Let's Encrypt's rate limits on repeated resets.
#
# Environment variables (all optional except PANEL_DOMAIN, which is asked
# interactively if omitted and a terminal is attached):
#   PANEL_DOMAIN          Domain for the panel, e.g. panel.example.com.
#                         Its DNS A record must already point at this server.
#   REMNAWAVE_DIR         Install dir for the panel. Default: /opt/remnawave
#   REMNAWAVE_BACKEND_REF Git ref of remnawave/backend to pull compose/env
#                         files from. Default: main
#   RESET_INSTALL          Set to 1 to wipe the existing install first.
#   RESET_INSTALL_CONFIRM   Set to 1 to skip the typed confirmation prompt
#                            (for scripted/non-interactive resets).
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

require_root
detect_os

REMNAWAVE_DIR="${REMNAWAVE_DIR:-/opt/remnawave}"
CADDY_DIR="$REMNAWAVE_DIR/caddy"
BOT_DIR="$SCRIPT_DIR/../bot"
BOOTSTRAP_OUT="$REMNAWAVE_DIR/bootstrap-summary.json"
BACKEND_REF="${REMNAWAVE_BACKEND_REF:-main}"
COMPOSE_URL="https://raw.githubusercontent.com/remnawave/backend/refs/heads/${BACKEND_REF}/docker-compose-prod.yml"
ENV_SAMPLE_URL="https://raw.githubusercontent.com/remnawave/backend/refs/heads/${BACKEND_REF}/.env.sample"

PANEL_DOMAIN="$(prompt_var PANEL_DOMAIN "Panel domain (DNS A record must already point at this server's IP)")"
[[ -n "$PANEL_DOMAIN" ]] || die "PANEL_DOMAIN is required"

install_docker

if [[ "${RESET_INSTALL:-}" == "1" ]]; then
    cat <<EOF

RESET_INSTALL=1: this will permanently delete the existing install before
setting it back up from scratch:
  - The Postgres database in $REMNAWAVE_DIR (every admin, config profile,
    node, user and subscription Remnawave knows about)
  - $REMNAWAVE_DIR/.env (generated secrets) and its docker-compose.yml
  - $CADDY_DIR/Caddyfile and its docker-compose.yml (the SSL certificate
    cache itself is kept, to avoid Let's Encrypt rate limits)
  - $BOOTSTRAP_OUT (API token / config profile / squad record)
  - $BOT_DIR/data (local trial-subscription tracking)

EOF
    confirm_or_die "About to wipe the Remnawave install for ${PANEL_DOMAIN}." RESET RESET_INSTALL_CONFIRM

    log_step "Wiping the existing install"
    if [[ -f "$CADDY_DIR/docker-compose.yml" ]]; then
        (cd "$CADDY_DIR" && docker compose down --remove-orphans) || true
    fi
    if [[ -f "$REMNAWAVE_DIR/docker-compose.yml" ]]; then
        (cd "$REMNAWAVE_DIR" && docker compose down -v --remove-orphans) || true
    fi
    rm -f "$REMNAWAVE_DIR/.env" "$REMNAWAVE_DIR/docker-compose.yml"
    rm -f "$CADDY_DIR/Caddyfile" "$CADDY_DIR/docker-compose.yml"
    rm -f "$BOOTSTRAP_OUT"
    rm -rf "$BOT_DIR/data"
    log_info "Wiped. Continuing with a fresh install."
fi

log_step "Configuring firewall (ssh, 80, 443)"
setup_firewall 80/tcp 443/tcp

install_pkgs curl openssl

mkdir -p "$REMNAWAVE_DIR"
cd "$REMNAWAVE_DIR"

if [[ -f .env ]]; then
    log_warn ".env already exists in $REMNAWAVE_DIR — assuming Remnawave is already installed, skipping secret generation."
else
    log_step "Downloading Remnawave Panel docker-compose.yml and .env.sample (ref: $BACKEND_REF)"
    curl -fsSL -o docker-compose.yml "$COMPOSE_URL"
    curl -fsSL -o .env "$ENV_SAMPLE_URL"

    log_step "Generating secrets"
    sed -i "s/^APP_SECRET=.*/APP_SECRET=$(random_hex 64)/" .env
    sed -i "s/^METRICS_PASS=.*/METRICS_PASS=$(random_hex 64)/" .env
    sed -i "s/^WEBHOOK_SECRET_HEADER=.*/WEBHOOK_SECRET_HEADER=$(random_hex 64)/" .env

    pw="$(openssl rand -hex 24)"
    sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$pw/" .env
    sed -i "s|^\(DATABASE_URL=\"postgresql://postgres:\)[^@]*\(@.*\)|\1$pw\2|" .env

    log_step "Configuring domain in .env ($PANEL_DOMAIN)"
    sed -i "s/^PANEL_DOMAIN=.*/PANEL_DOMAIN=$PANEL_DOMAIN/" .env
    sed -i "s/^FRONT_END_DOMAIN=.*/FRONT_END_DOMAIN=$PANEL_DOMAIN/" .env
    sed -i "s#^SUB_PUBLIC_DOMAIN=.*#SUB_PUBLIC_DOMAIN=$PANEL_DOMAIN/api/sub#" .env

    chmod 600 .env
fi

log_step "Starting Remnawave Panel (docker compose up -d)"
docker compose up -d

log_step "Waiting for the panel to become healthy"
wait_for_http_ok "http://127.0.0.1:3000" 90 || true

log_step "Setting up Caddy reverse proxy"
mkdir -p "$CADDY_DIR"
cd "$CADDY_DIR"

if [[ ! -f Caddyfile ]]; then
    cat >Caddyfile <<EOF
https://${PANEL_DOMAIN} {
        encode
        reverse_proxy * http://remnawave:3000
}
:443 {
    tls internal
    respond 204
}
EOF
fi

if [[ ! -f docker-compose.yml ]]; then
    cat >docker-compose.yml <<'EOF'
services:
  caddy:
    image: caddy:2.9
    container_name: 'caddy'
    hostname: caddy
    restart: always
    ports:
      - '0.0.0.0:443:443'
      - '0.0.0.0:80:80'
    networks:
      - remnawave-network
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-ssl-data:/data

networks:
  remnawave-network:
    name: remnawave-network
    driver: bridge
    external: true

volumes:
  caddy-ssl-data:
    driver: local
    external: false
    name: caddy-ssl-data
EOF
fi

docker compose up -d

if [[ -f "$BOOTSTRAP_OUT" ]]; then
    log_warn "$BOOTSTRAP_OUT already exists — panel already bootstrapped (API token/Reality config profile), skipping."
else
    log_step "Installing Node.js (to run the panel bootstrap script)"
    install_nodejs
    # better-sqlite3 (bot's local DB) ships prebuilt binaries for common
    # platforms, but falls back to compiling from source when none match —
    # build-essential makes sure that fallback actually works instead of
    # failing on a missing `make`.
    install_pkgs build-essential python3

    cat <<EOF

Remnawave only allows API tokens to be created from its own browser
dashboard (a scripted login session is deliberately rejected) — so before
continuing:

  1. Open https://${PANEL_DOMAIN} in a browser. The first visit registers
     the superadmin account — do this now, before anyone else can.
  2. In the dashboard, go to Remnawave Settings -> API Tokens and create
     a token.
  3. Have the Telegram user id(s) of the bot's admin(s) ready too (each
     admin can get their own id from a bot like @userinfobot).

EOF

    log_step "Bootstrapping the panel: API token check, VLESS+Reality config profile"
    ( cd "$BOT_DIR" && npm ci --no-audit --no-fund )
    (
        cd "$BOT_DIR"
        PANEL_URL="http://127.0.0.1:3000" OUT_FILE="$BOOTSTRAP_OUT" npm run --silent bootstrap
    )
    chmod 600 "$BOOTSTRAP_OUT"
fi

log_step "Done"
cat <<EOF

Remnawave Panel is up behind Caddy, and bootstrapped (a VLESS+Reality
inbound on top of the panel's own default config profile, reachable by
users, plus the API token and admin Telegram id(s) saved for the bot).

  Panel URL:        https://${PANEL_DOMAIN}
  Panel files:       ${REMNAWAVE_DIR} (.env has generated secrets, chmod 600)
  Caddy files:        ${CADDY_DIR}
  Bootstrap summary:   ${BOOTSTRAP_OUT} (API token — chmod 600)

Next steps:
  1. cd bot && cp .env.example .env, set BOT_TOKEN (from @BotFather), then
     npm run bot (or bot:dev) to start the Telegram bot.
  2. To add a VPN node, run scripts/add-node.sh — it registers the node
     and its Host entry on the panel via the API token from bootstrap, and
     prints (or, with NODE_SSH_HOST set, runs) the scripts/install-node.sh
     command for the node's own server.

For stronger perimeter security (MFA-protected login, API-key gated
/api/* routes) see Remnawave's own "Caddy with auth" guide and swap it in
later — this script intentionally starts with the minimal supported setup.
EOF
