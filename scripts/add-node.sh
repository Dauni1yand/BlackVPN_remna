#!/usr/bin/env bash
#
# Registers a new VPN node on the Remnawave panel (config profile check,
# node creation, host creation for subscriptions) via bot/src/cli/add-node.ts,
# then either prints the scripts/install-node.sh command to run on the
# node's server, or — if NODE_SSH_HOST is set — runs it there automatically
# over SSH. Run this on the MAIN server, after scripts/install-main-server.sh.
#
# Usage (print-only, run install-node.sh yourself on the node):
#   NODE_NAME=de-1 NODE_ADDRESS=203.0.113.10 bash scripts/add-node.sh
#
# Usage (fully automatic, requires root@<node> SSH access from this server):
#   NODE_NAME=de-1 NODE_ADDRESS=203.0.113.10 NODE_SSH_HOST=203.0.113.10 \
#       PANEL_IP=<this server's IP> bash scripts/add-node.sh
#
# Environment variables:
#   NODE_NAME            Required. Display name for the node in the panel.
#   NODE_ADDRESS          Required. Public IP/domain of the node server —
#                          used both for the panel<->node control channel
#                          and as the Host address clients connect to.
#   NODE_CONTROL_PORT      Default 2222. Panel<->node control port.
#   NODE_COUNTRY_CODE       Default XX.
#   NODE_SSH_HOST            Optional. If set, SSH there and run
#                            install-node.sh automatically.
#   NODE_SSH_USER             Default root.
#   NODE_SSH_PORT              Default 22.
#   PANEL_IP                    Recommended alongside NODE_SSH_HOST — the
#                                main server's IP, so the node's firewall
#                                only accepts the control port from it.
#   REMNAWAVE_DIR                 Default /opt/remnawave — where bootstrap's
#                                  summary (API token, config profile) lives.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
BOT_DIR="$(cd -- "$SCRIPT_DIR/../bot" &>/dev/null && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

require_cmd node || die "Node.js not found. Run scripts/install-main-server.sh first (it installs Node.js), or install it manually."

REMNAWAVE_DIR="${REMNAWAVE_DIR:-/opt/remnawave}"
BOOTSTRAP_SUMMARY_FILE="${BOOTSTRAP_SUMMARY_FILE:-$REMNAWAVE_DIR/bootstrap-summary.json}"

[[ -f "$BOOTSTRAP_SUMMARY_FILE" ]] || die "No bootstrap summary at $BOOTSTRAP_SUMMARY_FILE. Run scripts/install-main-server.sh first (or set API_TOKEN manually)."

NODE_NAME="$(prompt_var NODE_NAME "Node display name (e.g. de-1)")"
NODE_ADDRESS="$(prompt_var NODE_ADDRESS "Node's public IP or domain")"
[[ -n "$NODE_NAME" && -n "$NODE_ADDRESS" ]] || die "NODE_NAME and NODE_ADDRESS are required"

cd "$BOT_DIR"
if [[ ! -d node_modules ]]; then
    log_step "Installing bot dependencies"
    npm ci --no-audit --no-fund
fi

ADD_NODE_OUT="$(mktemp /tmp/blackvpn-add-node-XXXXXX.json)"
trap 'rm -f "$ADD_NODE_OUT"' EXIT

log_step "Registering node \"$NODE_NAME\" ($NODE_ADDRESS) on the panel"
PANEL_URL="${PANEL_URL:-http://127.0.0.1:3000}" \
    BOOTSTRAP_SUMMARY_FILE="$BOOTSTRAP_SUMMARY_FILE" \
    NODE_NAME="$NODE_NAME" \
    NODE_ADDRESS="$NODE_ADDRESS" \
    NODE_CONTROL_PORT="${NODE_CONTROL_PORT:-2222}" \
    NODE_COUNTRY_CODE="${NODE_COUNTRY_CODE:-XX}" \
    OUT_FILE="$ADD_NODE_OUT" \
    npm run --silent add-node

NODE_SSH_HOST="${NODE_SSH_HOST:-}"
if [[ -z "$NODE_SSH_HOST" ]]; then
    log_info "Node registered on the panel. Run the install-node.sh command printed above on the node's own server."
    exit 0
fi

SECRET_KEY="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ADD_NODE_OUT','utf8')).secretKey)")"
NODE_CONTROL_PORT_VALUE="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ADD_NODE_OUT','utf8')).nodeControlPort)")"
[[ -n "$SECRET_KEY" && -n "$NODE_CONTROL_PORT_VALUE" ]] || die "Could not read secretKey/nodeControlPort from $ADD_NODE_OUT"

NODE_SSH_USER="${NODE_SSH_USER:-root}"
NODE_SSH_PORT="${NODE_SSH_PORT:-22}"
PANEL_IP="${PANEL_IP:-}"
[[ -n "$PANEL_IP" ]] || log_warn "PANEL_IP not set — the node's control port will not be firewalled to this server specifically."

log_step "Installing Remnawave Node on $NODE_SSH_HOST via SSH"
ssh -p "$NODE_SSH_PORT" -o StrictHostKeyChecking=accept-new "${NODE_SSH_USER}@${NODE_SSH_HOST}" \
    "NODE_PORT='$NODE_CONTROL_PORT_VALUE' SECRET_KEY='$SECRET_KEY' PANEL_IP='$PANEL_IP' bash -s" \
    <"$SCRIPT_DIR/install-node.sh"

log_step "Done — \"$NODE_NAME\" is registered and running."
