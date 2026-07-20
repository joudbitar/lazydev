#!/usr/bin/env bash
# uninstall.sh — reverse install.sh, cross-platform.
#
# On macOS it boots out and removes the LaunchAgent plist; on Linux it stops,
# disables, and removes the systemd user unit. It also removes the `lazydev`
# CLI symlink, and — best effort — strips any legacy lazydev block an OLD Caddy
# based installer may have left in the system Caddyfile, so users upgrading from
# the Caddy topology end up clean. It does NOT delete the state directory; it
# prints the path so you can remove it yourself to erase every trace.
#
# Idempotent: safe to run repeatedly. Leaves all project code (daemon, scripts)
# in place.

set -euo pipefail

HOME_DIR="${HOME}"
CONFIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDER="${CONFIG_DIR}/bin/render-unit.mjs"
NODE_BIN="$(command -v node || true)"

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m  !\033[0m %s\n' "$*"; }

# --------------------------------------------------------------------------
# 0. Detect platform (fall back to uname if node is somehow missing)
# --------------------------------------------------------------------------

if [ -n "${NODE_BIN}" ] && [ -f "${RENDER}" ]; then
  PLATFORM="$("${NODE_BIN}" "${RENDER}" detect "$(uname -s)")"
else
  case "$(uname -s)" in
    Darwin) PLATFORM=darwin ;;
    Linux)  PLATFORM=linux ;;
    *)      PLATFORM=other ;;
  esac
fi

# Resolve the SAME state dir the installer used (for the closing hint only).
STATE_DIR=""
if [ -n "${NODE_BIN}" ] && [ -f "${CONFIG_DIR}/lib/state.mjs" ]; then
  STATE_DIR="$(cd "${CONFIG_DIR}" && "${NODE_BIN}" -e '
    import("./lib/state.mjs").then(({ resolveStateDir }) => {
      const os = require("os");
      process.stdout.write(resolveStateDir({ env: process.env, home: os.homedir(), scriptDir: process.cwd(), preferXdg: true }));
    });
  ' 2>/dev/null)"
fi

# --------------------------------------------------------------------------
# 1. Stop + remove the platform service unit
# --------------------------------------------------------------------------

remove_macos() {
  local label plist uid domain
  label="com.lazydev.proxy"
  plist="$("${NODE_BIN}" "${RENDER}" path darwin "${HOME_DIR}" "${XDG_CONFIG_HOME:-}" 2>/dev/null || echo "${HOME_DIR}/Library/LaunchAgents/${label}.plist")"
  uid="$(id -u)"
  domain="gui/${uid}"

  info "Stopping LaunchAgent ${label}"
  if launchctl bootout "${domain}/${label}" 2>/dev/null; then
    ok "booted out ${domain}/${label}"
  elif [ -f "${plist}" ] && launchctl unload "${plist}" 2>/dev/null; then
    ok "unloaded ${plist} (legacy)"
  else
    warn "no running LaunchAgent to stop (already gone)"
  fi

  if [ -f "${plist}" ]; then
    rm -f "${plist}"
    ok "removed plist ${plist}"
  else
    warn "plist already absent (${plist})"
  fi
}

remove_linux() {
  local unit
  unit="$("${NODE_BIN}" "${RENDER}" path linux "${HOME_DIR}" "${XDG_CONFIG_HOME:-}" 2>/dev/null || echo "${HOME_DIR}/.config/systemd/user/lazydev.service")"

  info "Stopping + disabling systemd user unit lazydev.service"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now lazydev.service >/dev/null 2>&1 && ok "disabled + stopped lazydev.service" \
      || warn "lazydev.service was not active (already gone)"
  else
    warn "systemctl not found; skipping service stop"
  fi

  if [ -f "${unit}" ]; then
    rm -f "${unit}"
    ok "removed unit ${unit}"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user daemon-reload >/dev/null 2>&1 || true
      systemctl --user reset-failed lazydev.service >/dev/null 2>&1 || true
    fi
  else
    warn "unit already absent (${unit})"
  fi
}

case "${PLATFORM}" in
  darwin) remove_macos ;;
  linux)  remove_linux ;;
  *)      warn "unrecognized platform '$(uname -s)'; skipping service removal" ;;
esac

# --------------------------------------------------------------------------
# 2. Remove the CLI symlink (only if it points into this project)
# --------------------------------------------------------------------------

CLI_LINK="${HOME_DIR}/.local/bin/lazydev"
if [ -L "${CLI_LINK}" ] && [ "$(readlink "${CLI_LINK}")" = "${CONFIG_DIR}/lazydev" ]; then
  rm -f "${CLI_LINK}"
  ok "removed CLI symlink ${CLI_LINK}"
fi

# --------------------------------------------------------------------------
# 3. Best-effort: strip a legacy Caddy block left by the OLD (Caddy) installer
# --------------------------------------------------------------------------

# Older lazydev installed a wildcard *.localhost block into the system Caddyfile
# and ran Caddy on :80. The daemon is the front door now (no Caddy), so remove
# that block if it is still there, leaving any other Caddy sites intact. This is
# entirely best-effort: no Caddy, no Caddyfile, or no lazydev block -> nothing.
CADDY_BIN="$(command -v caddy || true)"
BREW_PREFIX="$(brew --prefix 2>/dev/null || true)"
CADDYFILE="${BREW_PREFIX:-/opt/homebrew}/etc/Caddyfile"

if [ -n "${NODE_BIN}" ] && [ -f "${CADDYFILE}" ] && grep -q "Managed by lazydev" "${CADDYFILE}" 2>/dev/null; then
  info "Removing legacy lazydev block from ${CADDYFILE}"
  cp "${CADDYFILE}" "${CADDYFILE}.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
  # Drop both the sentinel-marked block and the older comment-through-brace form.
  TMP_CADDY="${CADDYFILE}.lazydev.tmp.$$"
  if awk '
    /^# >>> lazydev managed block >>>/ { inmarker=1; next }
    inmarker { if (/^# <<< lazydev managed block <<</) inmarker=0; next }
    /^# Managed by lazydev/ { inlegacy=1; next }
    inlegacy { if (/^}/) inlegacy=0; next }
    { print }
  ' "${CADDYFILE}" > "${TMP_CADDY}" 2>/dev/null; then
    mv "${TMP_CADDY}" "${CADDYFILE}"
    ok "removed legacy lazydev Caddy block (backup alongside)"
    # Reload Caddy so it drops :80; ignore failures (Caddy may not be running).
    if [ -n "${CADDY_BIN}" ]; then
      "${CADDY_BIN}" reload --config "${CADDYFILE}" >/dev/null 2>&1 \
        || brew services restart caddy >/dev/null 2>&1 || true
    fi
  else
    rm -f "${TMP_CADDY}" 2>/dev/null || true
    warn "could not rewrite the Caddyfile; leaving it untouched"
  fi
fi

# --------------------------------------------------------------------------
# 4. Summary
# --------------------------------------------------------------------------

echo
info "lazydev uninstall summary"
ok "user service stopped + unit removed"
ok "CLI symlink removed (project code under ${CONFIG_DIR} left intact)"
echo
if [ -n "${STATE_DIR}" ]; then
  info "State (registry, logs, control token) is still at:"
  printf '      %s\n' "${STATE_DIR}"
  info "Delete that directory to remove every trace:"
  printf '      rm -rf %s\n' "${STATE_DIR}"
fi
echo
ok "Done. The lazydev daemon will no longer start on boot."
