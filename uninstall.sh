#!/usr/bin/env bash
# uninstall.sh — reverse install.sh.
#
# Idempotent: boots out the LaunchAgent, removes the plist, restores the most
# recent Caddyfile backup (or writes a minimal passthrough), and reloads Caddy.
# Leaves all project code (daemon, registry, scripts) in place.

set -euo pipefail

HOME_DIR="${HOME}"
CONFIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LABEL="com.lazydev.proxy"
PLIST="${HOME_DIR}/Library/LaunchAgents/${LABEL}.plist"

CADDY_BIN="$(command -v caddy || echo /opt/homebrew/bin/caddy)"
BREW_PREFIX="$(brew --prefix 2>/dev/null || true)"
CADDYFILE="${BREW_PREFIX:-/opt/homebrew}/etc/Caddyfile"

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
# 2b. Remove the CLI symlink (only if it points into this project)
# --------------------------------------------------------------------------

CLI_LINK="${HOME_DIR}/.local/bin/lazydev"
if [ -L "${CLI_LINK}" ] && [ "$(readlink "${CLI_LINK}")" = "${CONFIG_DIR}/lazydev" ]; then
  rm -f "${CLI_LINK}"
  ok "removed CLI symlink ${CLI_LINK}"
fi

# --------------------------------------------------------------------------
# 3. Remove the lazydev block from the Caddyfile (leave other sites intact)
# --------------------------------------------------------------------------

info "Removing lazydev block from Caddyfile"

if [ -f "${CADDYFILE}" ] && grep -q "Managed by lazydev" "${CADDYFILE}"; then
  cp "${CADDYFILE}" "${CADDYFILE}.bak.$(date +%Y%m%d%H%M%S)"
  # Drop the two comment lines, the "http://*.localhost ... {" opener, its
  # reverse_proxy line, and the closing brace — the exact block install appended.
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    const lines = fs.readFileSync(f, "utf8").split("\n");
    const out = [];
    let skip = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("Managed by lazydev")) { skip = 1; continue; }
      if (skip && lines[i].includes("*.localhost") && lines[i].includes("{")) { skip = 2; continue; }
      if (skip === 2) { if (lines[i].trim() === "}") skip = 0; continue; }
      if (skip === 1) { if (lines[i].trim().startsWith("#") || lines[i].trim() === "") continue; skip = 0; }
      out.push(lines[i]);
    }
    fs.writeFileSync(f, out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, ""));
  ' "${CADDYFILE}"
  ok "removed lazydev block (backup alongside)"
else
  warn "no lazydev block found in Caddyfile (already gone)"
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
