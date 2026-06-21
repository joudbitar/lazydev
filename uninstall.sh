#!/usr/bin/env bash
# uninstall.sh — reverse install.sh.
#
# Idempotent: boots out the LaunchAgent, removes the plist, restores the most
# recent Caddyfile backup (or writes a minimal passthrough), and reloads Caddy.
# Leaves all ~/.config/lazydev/ code (daemon, registry, scripts) in place.

set -euo pipefail

HOME_DIR="/Users/joudbitar"
CONFIG_DIR="${HOME_DIR}/.config/lazydev"

LABEL="com.lazydev.proxy"
PLIST="${HOME_DIR}/Library/LaunchAgents/${LABEL}.plist"

CADDYFILE="/opt/homebrew/etc/Caddyfile"
CADDY_BIN="/opt/homebrew/bin/caddy"

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m  !\033[0m %s\n' "$*"; }

# --------------------------------------------------------------------------
# 1. Stop + unload the LaunchAgent
# --------------------------------------------------------------------------

info "Stopping LaunchAgent ${LABEL}"

UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

if launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null; then
  ok "booted out ${DOMAIN}/${LABEL}"
else
  # Fall back to legacy unload (covers daemons loaded the old way).
  if [ -f "${PLIST}" ] && launchctl unload "${PLIST}" 2>/dev/null; then
    ok "unloaded ${PLIST} (legacy)"
  else
    warn "no running LaunchAgent to stop (already gone)"
  fi
fi

# --------------------------------------------------------------------------
# 2. Remove the plist
# --------------------------------------------------------------------------

if [ -f "${PLIST}" ]; then
  rm -f "${PLIST}"
  ok "removed plist ${PLIST}"
else
  warn "plist already absent (${PLIST})"
fi

# --------------------------------------------------------------------------
# 3. Restore the Caddyfile
# --------------------------------------------------------------------------

info "Restoring Caddyfile"

# Find the most recent Caddyfile.bak.* (newest by name; timestamps sort lexically).
LATEST_BAK=""
for f in "${CADDYFILE}".bak.*; do
  [ -e "${f}" ] || continue
  LATEST_BAK="${f}"
done

if [ -n "${LATEST_BAK}" ]; then
  cp "${LATEST_BAK}" "${CADDYFILE}"
  ok "restored ${CADDYFILE} from ${LATEST_BAK}"
else
  warn "no Caddyfile.bak.* found; writing a minimal passthrough"
  cat > "${CADDYFILE}" <<'CADDY_EOF'
# Minimal passthrough written by lazydev uninstall (no prior backup found).
# No sites configured. Add your own server blocks here.
CADDY_EOF
  ok "wrote minimal passthrough ${CADDYFILE}"
fi

# --------------------------------------------------------------------------
# 4. Reload Caddy
# --------------------------------------------------------------------------

info "Reloading Caddy"
if "${CADDY_BIN}" reload --config "${CADDYFILE}" 2>/dev/null; then
  ok "caddy reload succeeded"
else
  warn "caddy reload failed; restarting brew service"
  if brew services restart caddy >/dev/null 2>&1; then
    ok "brew services restart caddy succeeded"
  else
    warn "could not reload or restart caddy automatically"
  fi
fi

# --------------------------------------------------------------------------
# 5. Summary
# --------------------------------------------------------------------------

echo
info "lazydev uninstall summary"
ok "LaunchAgent stopped + plist removed"
ok "Caddyfile restored (config code under ${CONFIG_DIR} left intact)"
echo
ok "Done. The lazydev daemon will no longer start on boot."
