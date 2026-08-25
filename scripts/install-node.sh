#!/usr/bin/env bash
#
# Installs Remnawave Node (Xray-core) on a fresh Ubuntu/Debian server and
# connects it back to the main panel. This is what the admin panel's
# "add node" command is meant to run remotely (over SSH) against a new
# node server — see the project's Telegram admin bot for the automated
# caller of this script.
#
# The SECRET_KEY below is NOT something this script invents: it must come
# from the panel itself (Nodes -> Add node -> "Copy docker-compose.yml" in
# the UI, or the panel's node keygen API), because the node has to present
# a certificate signed by the panel's own CA to be trusted.
#
# Usage:
#   sudo NODE_PORT=2222 SECRET_KEY='...' PANEL_IP=1.2.3.4 \
#       bash scripts/install-node.sh
#
# Environment variables:
#   NODE_PORT   Required. Port Remnawave Node listens on for the panel's
#               internal API calls (not a user-facing VPN port).
#   SECRET_KEY  Required. The node auth payload issued by the panel.
#   PANEL_IP    Recommended. Main server's IP; NODE_PORT is firewalled to
#               only accept connections from this address. If omitted,
#               NODE_PORT is left closed and must be opened manually.
#   REMNANODE_DIR  Install dir. Default: /opt/remnanode
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

require_root
detect_os

NODE_PORT="$(prompt_var NODE_PORT "Node port (panel <-> node internal API)")"
SECRET_KEY="$(prompt_var SECRET_KEY "SECRET_KEY issued by the panel for this node")"
PANEL_IP="${PANEL_IP:-}"
REMNANODE_DIR="${REMNANODE_DIR:-/opt/remnanode}"

[[ -n "$NODE_PORT" ]] || die "NODE_PORT is required"
[[ -n "$SECRET_KEY" ]] || die "SECRET_KEY is required (get it from the panel when adding this node)"

install_docker

mkdir -p "$REMNANODE_DIR"
cat >"$REMNANODE_DIR/docker-compose.yml" <<EOF
services:
  remnanode:
    container_name: remnanode
    hostname: remnanode
    image: remnawave/node:latest
    restart: always
    network_mode: host
    environment:
      - NODE_PORT=${NODE_PORT}
      - SECRET_KEY=${SECRET_KEY}
EOF
chmod 600 "$REMNANODE_DIR/docker-compose.yml"

log_step "Configuring firewall (ssh always; NODE_PORT restricted to the panel)"
setup_firewall
if [[ -n "$PANEL_IP" ]]; then
    ufw_allow_from "$PANEL_IP" "${NODE_PORT}/tcp" "remnawave panel -> node API"
    log_info "Opened ${NODE_PORT}/tcp for ${PANEL_IP} only."
else
    log_warn "PANEL_IP not set: ${NODE_PORT}/tcp was NOT opened. The panel won't be able to reach this node until you allow it, e.g.:"
    log_warn "  ufw allow from <panel-ip> to any port ${NODE_PORT} proto tcp"
fi

log_step "Starting Remnawave Node (docker compose up -d)"
cd "$REMNANODE_DIR"
docker compose up -d

log_step "Done"
cat <<EOF

Remnawave Node is running on this server.

Remaining manual step (or via the panel API): the panel does not
auto-discover nodes. In the panel, finish adding this node under
Nodes -> Management with this server's address and port ${NODE_PORT},
picking a Config Profile — then it will start serving traffic.

Note: the inbound (user-facing) VPN ports are defined by whichever Config
Profile you attach to this node, and are opened by whoever manages that
profile — this script only opens the panel<->node control port above.
EOF
