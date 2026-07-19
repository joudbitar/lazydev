#!/usr/bin/env bash
# install.sh — install/refresh the lazydev LaunchAgent + wildcard Caddyfile.
#
# Idempotent: safe to run repeatedly. Writes the launchd plist, (re)loads the
# daemon on :4000, installs the wildcard *.localhost Caddyfile, and reloads
# Caddy on :80. Validates the daemon and registry before touching anything.
#
# See ./SPEC.md (project root) for the topology.

set -euo pipefail

# --------------------------------------------------------------------------
# Constants (single-sourced)
# --------------------------------------------------------------------------

HOME_DIR="${HOME}"
# This installer lives at the project root — install whatever folder it's in,
# so the project is fully relocatable (clone/move it anywhere, then run this).
CONFIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON="${CONFIG_DIR}/lazydev.mjs"
REGISTRY="${CONFIG_DIR}/projects.json"
LOGS_DIR="${CONFIG_DIR}/logs"

LABEL="com.lazydev.proxy"
PLIST="${HOME_DIR}/Library/LaunchAgents/${LABEL}.plist"

DAEMON_PORT=4000
CADDY_PORT=80

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------------------
# 1. Validate
# --------------------------------------------------------------------------

info "Validating daemon + registry"

# Locate the tools on THIS machine; no hardcoded install paths.
NODE_BIN="$(command -v node || true)"
[ -n "${NODE_BIN}" ] || fail "node not found on PATH (need Node 18+)"

CADDY_BIN="$(command -v caddy || true)"
if [ -z "${CADDY_BIN}" ]; then
  for c in /opt/homebrew/bin/caddy /usr/local/bin/caddy; do
    if [ -x "${c}" ]; then CADDY_BIN="${c}"; break; fi
  done
fi
[ -n "${CADDY_BIN}" ] || fail "caddy not found (brew install caddy)"

BREW_PREFIX="$(brew --prefix 2>/dev/null || true)"
CADDYFILE="${BREW_PREFIX:-/opt/homebrew}/etc/Caddyfile"

# launchd hands processes a minimal PATH, but the daemon spawns `pnpm dev` /
# `npm run dev`, so node, the package managers, and caddy must all be reachable.
LAUNCHD_PATH="$(dirname "${NODE_BIN}"):$(dirname "${CADDY_BIN}")"
for tool in npm pnpm yarn bun; do
  p="$(command -v "${tool}" 2>/dev/null || true)"
  if [ -n "${p}" ]; then LAUNCHD_PATH="${LAUNCHD_PATH}:$(dirname "${p}")"; fi
done
# pnpm's default PNPM_HOME on macOS, if present.
if [ -d "${HOME_DIR}/Library/pnpm" ]; then LAUNCHD_PATH="${LAUNCHD_PATH}:${HOME_DIR}/Library/pnpm"; fi
LAUNCHD_PATH="${LAUNCHD_PATH}:${HOME_DIR}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LAUNCHD_PATH="$(printf '%s' "${LAUNCHD_PATH}" | awk -v RS=: '!seen[$0]++ { printf "%s%s", sep, $0; sep=":" }')"
ok "tools: node=${NODE_BIN}, caddy=${CADDY_BIN}"

[ -f "${DAEMON}" ]   || fail "daemon not found at ${DAEMON}"
if [ ! -f "${REGISTRY}" ]; then
  printf '%s\n' '{ "port": 4000, "idleTimeoutMs": 1800000, "startTimeoutMs": 120000, "projects": [] }' > "${REGISTRY}"
  ok "created empty registry (run 'lazydev scan' to fill it)"
fi

if ! "${NODE_BIN}" --check "${DAEMON}"; then
  fail "syntax check failed: ${DAEMON}"
fi
ok "daemon parses cleanly (${DAEMON})"

if ! "${NODE_BIN}" -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "${REGISTRY}"; then
  fail "registry is not valid JSON: ${REGISTRY}"
fi
ok "registry is valid JSON (${REGISTRY})"

mkdir -p "${LOGS_DIR}"
ok "logs dir ready (${LOGS_DIR})"

# --------------------------------------------------------------------------
# 2. Write the LaunchAgent plist
# --------------------------------------------------------------------------

info "Writing LaunchAgent plist -> ${PLIST}"

mkdir -p "${HOME_DIR}/Library/LaunchAgents"

cat > "${PLIST}" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${DAEMON}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>WorkingDirectory</key>
    <string>${CONFIG_DIR}</string>

    <key>StandardOutPath</key>
    <string>${LOGS_DIR}/daemon.out</string>

    <key>StandardErrorPath</key>
    <string>${LOGS_DIR}/daemon.err</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME_DIR}</string>
        <key>PATH</key>
        <string>${LAUNCHD_PATH}</string>
    </dict>
</dict>
</plist>
PLIST_EOF

ok "plist written"

# Lint the plist (non-fatal report if plutil is unavailable).
if command -v plutil >/dev/null 2>&1; then
  if plutil -lint "${PLIST}" >/dev/null; then
    ok "plist passes plutil -lint"
  else
    fail "plist is malformed (plutil -lint)"
  fi
fi

# --------------------------------------------------------------------------
# 3. (Re)load via launchd
# --------------------------------------------------------------------------

info "Loading LaunchAgent into launchd"

UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

# Tear down any existing instance first so this is a clean (re)load.
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true

# Modern bootstrap; fall back to legacy load if bootstrap is unavailable.
if launchctl bootstrap "${DOMAIN}" "${PLIST}"; then
  ok "bootstrapped ${DOMAIN}/${LABEL}"
else
  warn "bootstrap failed; falling back to legacy load"
  launchctl unload "${PLIST}" 2>/dev/null || true
  launchctl load -w "${PLIST}"
  ok "legacy load complete"
fi

launchctl enable "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl kickstart -k "${DOMAIN}/${LABEL}" 2>/dev/null || true

# Poll up to ~10s for the daemon to listen on :4000.
info "Waiting for daemon on :${DAEMON_PORT}"
DAEMON_UP=0
for _ in $(seq 1 20); do
  if "${NODE_BIN}" -e "
    const net = require('net');
    const s = net.connect({ host: '127.0.0.1', port: ${DAEMON_PORT} });
    s.setTimeout(400);
    s.once('connect', () => { s.destroy(); process.exit(0); });
    s.once('timeout', () => { s.destroy(); process.exit(1); });
    s.once('error',   () => { process.exit(1); });
  " 2>/dev/null; then
    DAEMON_UP=1
    break
  fi
  sleep 0.5
done

if [ "${DAEMON_UP}" -eq 1 ]; then
  ok "daemon is listening on :${DAEMON_PORT}"
else
  warn "daemon did NOT come up on :${DAEMON_PORT} within ~10s"
  warn "check ${LOGS_DIR}/daemon.err and ${LOGS_DIR}/daemon.log"
fi

# --------------------------------------------------------------------------
# 3b. Link the CLI onto PATH (~/.local/bin/lazydev)
# --------------------------------------------------------------------------

info "Linking CLI -> ${HOME_DIR}/.local/bin/lazydev"
mkdir -p "${HOME_DIR}/.local/bin"
ln -sf "${CONFIG_DIR}/lazydev" "${HOME_DIR}/.local/bin/lazydev"
ok "lazydev CLI linked (make sure ${HOME_DIR}/.local/bin is on your PATH)"

# --------------------------------------------------------------------------
# 4. Write the wildcard Caddyfile + reload Caddy
# --------------------------------------------------------------------------

info "Installing wildcard Caddyfile block -> ${CADDYFILE}"

mkdir -p "$(dirname "${CADDYFILE}")"

# Append the lazydev block if it isn't there yet; never clobber other sites.
if [ -f "${CADDYFILE}" ] && grep -q "Managed by lazydev" "${CADDYFILE}"; then
  ok "Caddyfile already has the lazydev block"
else
  if [ -f "${CADDYFILE}" ]; then
    BACKUP="${CADDYFILE}.bak.$(date +%Y%m%d%H%M%S)"
    cp "${CADDYFILE}" "${BACKUP}"
    ok "backed up existing Caddyfile -> ${BACKUP}"
  fi
  cat >> "${CADDYFILE}" <<'CADDY_EOF'

# Managed by lazydev. All *.localhost names route to the on-demand daemon on
# :4000, which wakes each project's dev server on first hit and sleeps it when idle.
http://*.localhost, http://*.*.localhost {
    reverse_proxy localhost:4000
}
CADDY_EOF
  ok "lazydev block appended to Caddyfile"
fi

# Reload Caddy WITHOUT sudo; fall back to a service restart.
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

# Verify Caddy is listening on :80.
info "Waiting for Caddy on :${CADDY_PORT}"
CADDY_UP=0
for _ in $(seq 1 20); do
  if "${NODE_BIN}" -e "
    const net = require('net');
    const s = net.connect({ host: '127.0.0.1', port: ${CADDY_PORT} });
    s.setTimeout(400);
    s.once('connect', () => { s.destroy(); process.exit(0); });
    s.once('timeout', () => { s.destroy(); process.exit(1); });
    s.once('error',   () => { process.exit(1); });
  " 2>/dev/null; then
    CADDY_UP=1
    break
  fi
  sleep 0.5
done

if [ "${CADDY_UP}" -eq 1 ]; then
  ok "caddy is listening on :${CADDY_PORT}"
else
  warn "caddy did NOT come up on :${CADDY_PORT} within ~10s"
fi

# --------------------------------------------------------------------------
# 5. Final summary
# --------------------------------------------------------------------------

echo
info "lazydev install summary"
if [ "${DAEMON_UP}" -eq 1 ]; then
  ok "daemon:  running on :${DAEMON_PORT}"
else
  warn "daemon:  NOT confirmed on :${DAEMON_PORT}"
fi
if [ "${CADDY_UP}" -eq 1 ]; then
  ok "caddy:   running on :${CADDY_PORT} (wildcard *.localhost -> :${DAEMON_PORT})"
else
  warn "caddy:   NOT confirmed on :${CADDY_PORT}"
fi
echo
info "Dashboard: http://lazydev.localhost"
echo

if [ "${DAEMON_UP}" -eq 1 ] && [ "${CADDY_UP}" -eq 1 ]; then
  ok "lazydev is up. Visit http://lazydev.localhost to see all projects."
else
  warn "lazydev install completed with warnings — see above."
fi
