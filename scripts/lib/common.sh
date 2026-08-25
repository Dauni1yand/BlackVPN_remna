#!/usr/bin/env bash
# Shared helpers for the install scripts. Not meant to be executed directly.

if [[ -n "${BLACKVPN_COMMON_SH_LOADED:-}" ]]; then
    return 0 2>/dev/null || exit 0
fi
BLACKVPN_COMMON_SH_LOADED=1

COLOR_RED='\033[0;31m'
COLOR_GREEN='\033[0;32m'
COLOR_YELLOW='\033[1;33m'
COLOR_BLUE='\033[0;34m'
COLOR_RESET='\033[0m'

log_step() { printf "\n${COLOR_BLUE}==>${COLOR_RESET} %s\n" "$*"; }
log_info() { printf "${COLOR_GREEN}[ok]${COLOR_RESET} %s\n" "$*"; }
log_warn() { printf "${COLOR_YELLOW}[warn]${COLOR_RESET} %s\n" "$*" >&2; }
log_error() { printf "${COLOR_RED}[error]${COLOR_RESET} %s\n" "$*" >&2; }
die() {
    log_error "$*"
    exit 1
}

require_root() {
    if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
        die "This script must be run as root (try: sudo bash $0)"
    fi
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1
}

# Detects an apt-based OS (Ubuntu/Debian) and fails fast on anything else,
# since every install step below assumes apt + systemd.
detect_os() {
    if [[ ! -f /etc/os-release ]]; then
        die "Cannot detect OS: /etc/os-release not found"
    fi
    # shellcheck source=/dev/null
    . /etc/os-release
    case "${ID:-}:${ID_LIKE:-}" in
        ubuntu*|debian*|*:*ubuntu*|*:*debian*) ;;
        *) die "Unsupported OS ($PRETTY_NAME). This script supports Ubuntu/Debian only." ;;
    esac
    if ! require_cmd apt-get; then
        die "apt-get not found. This script supports Ubuntu/Debian only."
    fi
    log_info "OS: ${PRETTY_NAME:-$ID}"
}

# Reads a value for VAR_NAME: if the environment variable is already set, use
# it as-is (this is what lets the script run non-interactively, e.g. driven
# by the admin Telegram bot over SSH). Otherwise, if a TTY is attached, ask
# the operator. If neither is available, fail with a clear instruction.
prompt_var() {
    local var_name="$1" question="$2" default_value="${3:-}"
    local current="${!var_name:-}"

    if [[ -n "$current" ]]; then
        printf '%s\n' "$current"
        return 0
    fi

    if [[ -t 0 ]]; then
        local answer
        if [[ -n "$default_value" ]]; then
            read -r -p "$question [$default_value]: " answer </dev/tty
            answer="${answer:-$default_value}"
        else
            read -r -p "$question: " answer </dev/tty
        fi
        printf '%s\n' "$answer"
        return 0
    fi

    die "$var_name is not set and no TTY is attached to prompt for it. Re-run with $var_name=... set in the environment."
}

random_hex() {
    local bytes="${1:-32}"
    openssl rand -hex "$bytes"
}

apt_update_once_marker="/var/run/blackvpn-apt-updated"
apt_update_once() {
    if [[ -f "$apt_update_once_marker" ]] && [[ $(( $(date +%s) - $(stat -c %Y "$apt_update_once_marker" 2>/dev/null || echo 0) )) -lt 600 ]]; then
        return 0
    fi
    apt-get update -y
    touch "$apt_update_once_marker"
}

install_pkgs() {
    apt_update_once
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

# Idempotent Docker Engine + Compose plugin install via the official
# get.docker.com script (same approach Remnawave's own docs recommend).
install_docker() {
    if require_cmd docker && docker compose version >/dev/null 2>&1; then
        log_info "Docker is already installed: $(docker --version)"
        return 0
    fi
    log_step "Installing Docker Engine + Compose plugin"
    install_pkgs curl ca-certificates
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
    log_info "Docker installed: $(docker --version)"
}

# Idempotent Node.js LTS install via NodeSource. Needed on the main server
# to run bot/ (panel bootstrap + node registration CLIs, and later the bot
# itself).
install_nodejs() {
    if require_cmd node && [[ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -ge 18 ]]; then
        log_info "Node.js is already installed: $(node --version)"
        return 0
    fi
    log_step "Installing Node.js 20.x (NodeSource)"
    install_pkgs curl ca-certificates gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    install_pkgs nodejs
    log_info "Node.js installed: $(node --version)"
}

# Base firewall: SSH always allowed, deny everything else by default.
# Extra "port/proto" pairs (e.g. "80/tcp" "443/tcp") can be opened to
# everyone; use ufw_allow_from for source-restricted rules (nodes).
setup_firewall() {
    install_pkgs ufw
    ufw allow OpenSSH >/dev/null
    for rule in "$@"; do
        ufw allow "$rule" >/dev/null
    done
    ufw --force enable >/dev/null
    log_info "ufw enabled. Rules:"
    ufw status verbose
}

ufw_allow_from() {
    local source_ip="$1" port_proto="$2" comment="$3"
    install_pkgs ufw
    ufw allow from "$source_ip" to any port "${port_proto%%/*}" proto "${port_proto##*/}" comment "$comment" >/dev/null
}

wait_for_http_ok() {
    local url="$1" timeout_s="${2:-60}"
    local waited=0
    until curl -fsS -o /dev/null "$url" 2>/dev/null; do
        sleep 2
        waited=$((waited + 2))
        if [[ "$waited" -ge "$timeout_s" ]]; then
            log_warn "Timed out waiting for $url to respond (waited ${timeout_s}s). It may still be starting up."
            return 1
        fi
    done
    return 0
}
