#!/usr/bin/env bash
# install.sh — install/refresh the persistent lazydev daemon as a user service.
#
# Cross-platform. On macOS it writes a launchd LaunchAgent; on Linux a systemd
# user unit. Both run the SAME daemon (lazydev.mjs) against the SAME state
# directory, serving the front door directly on :80 — there is NO Caddy and no
# second proxy (see docs/adr/0001-npx-front-door.md). macOS lets an unprivileged
# process bind :80; the Linux unit grants CAP_NET_BIND_SERVICE. If :80 cannot be
# bound the daemon falls back to a numbered port on its own.
#
# Idempotent: safe to run repeatedly. It scans your home dir into the state dir,
# writes the unit, (re)loads it, links the `lazydev` CLI onto PATH, and validates
# node + the daemon + the registry before touching anything. State (registry,
# logs, control token) lives under the state dir, shared with `npx lazydev`.
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
SCANNER="${CONFIG_DIR}/scan.mjs"
RENDER="${CONFIG_DIR}/bin/render-unit.mjs"

# The front door the daemon serves on, and the port it falls back to when :80
# cannot be bound. Kept in sync with lib/service.mjs (which the units embed).
FRONT_PORT=80
FALLBACK_PORT=4000

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

# True if something is listening on the given TCP port on 127.0.0.1. Uses node
# (already required) so this works identically on macOS and Linux with no lsof.
port_listening() {
  local p="$1"
  "${NODE_BIN}" -e "
    const net = require('net');
    const s = net.connect({ host: '127.0.0.1', port: ${p} });
    s.setTimeout(400);
    s.once('connect', () => { s.destroy(); process.exit(0); });
    s.once('timeout', () => { s.destroy(); process.exit(1); });
    s.once('error',   () => { process.exit(1); });
  " 2>/dev/null
}

# --------------------------------------------------------------------------
# Platform install steps
# --------------------------------------------------------------------------

# macOS: write the LaunchAgent plist and (re)load it via launchctl. The daemon
# binds :80 directly (macOS allows the unprivileged bind).
install_macos() {
  info "Writing LaunchAgent plist -> ${UNIT_PATH}"
  mkdir -p "$(dirname "${UNIT_PATH}")"

  "${NODE_BIN}" "${RENDER}" launchd \
    "${NODE_BIN}" "${DAEMON}" "${CONFIG_DIR}" "${STATE_DIR}" "${LOGS_DIR}" "${HOME_DIR}" "${SERVICE_PATH}" \
    > "${UNIT_PATH}"
  ok "plist written"

  # Lint the plist (fatal if malformed; skipped if plutil is unavailable).
  if command -v plutil >/dev/null 2>&1; then
    if plutil -lint "${UNIT_PATH}" >/dev/null; then
      ok "plist passes plutil -lint"
    else
      fail "plist is malformed (plutil -lint)"
    fi
  fi

  info "Loading LaunchAgent into launchd"
  local uid domain
  uid="$(id -u)"
  domain="gui/${uid}"

  # Tear down any existing instance first so this is a clean (re)load.
  launchctl bootout "${domain}/${LABEL}" 2>/dev/null || true

  if launchctl bootstrap "${domain}" "${UNIT_PATH}"; then
    ok "bootstrapped ${domain}/${LABEL}"
  else
    warn "bootstrap failed; falling back to legacy load"
    launchctl unload "${UNIT_PATH}" 2>/dev/null || true
    launchctl load -w "${UNIT_PATH}"
    ok "legacy load complete"
  fi

  launchctl enable "${domain}/${LABEL}" 2>/dev/null || true
  launchctl kickstart -k "${domain}/${LABEL}" 2>/dev/null || true
}

# Linux: write the systemd user unit and enable --now via systemctl --user. The
# unit grants CAP_NET_BIND_SERVICE so the daemon can bind :80 unprivileged.
install_linux() {
  command -v systemctl >/dev/null 2>&1 || fail "systemctl not found. lazydev's Linux install needs systemd (user services)."

  info "Writing systemd user unit -> ${UNIT_PATH}"
  mkdir -p "$(dirname "${UNIT_PATH}")"

  "${NODE_BIN}" "${RENDER}" systemd \
    "${NODE_BIN}" "${DAEMON}" "${CONFIG_DIR}" "${STATE_DIR}" "${SERVICE_PATH}" \
    > "${UNIT_PATH}"
  ok "unit written"

  info "Enabling the service (systemctl --user)"
  systemctl --user daemon-reload
  if systemctl --user enable --now lazydev.service; then
    ok "lazydev.service enabled and started"
  else
    warn "enable --now failed; check: systemctl --user status lazydev.service"
  fi

  # Lingering lets the user service run without an active login session (survives
  # logout, starts on boot). Enable it if we can; otherwise tell the user how.
  if command -v loginctl >/dev/null 2>&1; then
    if loginctl enable-linger "$(id -un)" 2>/dev/null; then
      ok "lingering enabled (service survives logout)"
    else
      warn "could not enable lingering automatically."
      warn "run this so the daemon survives logout:  loginctl enable-linger $(id -un)"
    fi
  else
    warn "loginctl not found; to keep the daemon running after logout, enable lingering for your user."
  fi
}

# --------------------------------------------------------------------------
# Front-door wait + summary
# --------------------------------------------------------------------------

# The daemon serves :80 when it can bind it, or the numbered fallback otherwise.
# Poll both so the summary is honest about which one came up.
SERVING_PORT=""
wait_for_front_door() {
  info "Waiting for the daemon on :${FRONT_PORT} (or :${FALLBACK_PORT})"
  local _
  for _ in $(seq 1 20); do
    if port_listening "${FRONT_PORT}"; then SERVING_PORT="${FRONT_PORT}"; return 0; fi
    if port_listening "${FALLBACK_PORT}"; then SERVING_PORT="${FALLBACK_PORT}"; return 0; fi
    sleep 0.5
  done
  return 1
}

print_summary() {
  echo
  info "lazydev install summary"
  if [ -n "${SERVING_PORT}" ]; then
    ok "daemon: running on :${SERVING_PORT} (serves *.localhost directly, no Caddy)"
  else
    warn "daemon: NOT confirmed on :${FRONT_PORT} or :${FALLBACK_PORT} within ~10s"
    warn "check the daemon log:  lazydev daemon-logs"
  fi
  echo
  ok "state dir: ${STATE_DIR}  (registry, logs, control token — shared with npx lazydev)"
  if [ -n "${SERVING_PORT}" ] && [ "${SERVING_PORT}" != "80" ]; then
    info "Front door on :${SERVING_PORT} — visit http://lazydev.localhost:${SERVING_PORT}"
  else
    info "Dashboard: http://lazydev.localhost"
  fi
  echo
  if [ -n "${SERVING_PORT}" ]; then
    ok "lazydev is up. Run 'lazydev' to see all projects."
  else
    warn "lazydev install completed with warnings — see above."
  fi
}

# --------------------------------------------------------------------------
# 1. Locate node + detect platform
# --------------------------------------------------------------------------

info "Validating environment"

# Locate node on THIS machine; no hardcoded install paths.
NODE_BIN="$(command -v node || true)"
[ -n "${NODE_BIN}" ] || fail "node not found on PATH (need Node 18+)"

# Platform detection routed through the pure decision in lib/service.mjs, so the
# installer and the node --test suite agree on the mapping.
PLATFORM="$("${NODE_BIN}" "${RENDER}" detect "$(uname -s)")"
case "${PLATFORM}" in
  darwin) ok "platform: macOS (launchd LaunchAgent)" ;;
  linux)  ok "platform: Linux (systemd user unit)" ;;
  *)      fail "unsupported platform '$(uname -s)'. lazydev installs on macOS and Linux." ;;
esac

# --------------------------------------------------------------------------
# 2. Resolve the state directory (shared with `npx lazydev`)
# --------------------------------------------------------------------------

# ONE state dir holds the registry, logs, and control token. Resolve the SAME
# XDG-based path the npx entrypoint uses (LAZYDEV_STATE_DIR wins if you set it),
# so an npx run and this install share a layout and your registry carries over.
STATE_DIR="$(cd "${CONFIG_DIR}" && "${NODE_BIN}" -e '
  import("./lib/state.mjs").then(({ resolveStateDir }) => {
    const os = require("os");
    process.stdout.write(resolveStateDir({ env: process.env, home: os.homedir(), scriptDir: process.cwd(), preferXdg: true }));
  });
' 2>/dev/null)"
[ -n "${STATE_DIR}" ] || fail "could not resolve the state directory"
LOGS_DIR="${STATE_DIR}/logs"
REGISTRY="${STATE_DIR}/projects.json"

mkdir -p "${STATE_DIR}" "${LOGS_DIR}"
ok "state dir: ${STATE_DIR}"

# --------------------------------------------------------------------------
# 3. Build the PATH the daemon inherits
# --------------------------------------------------------------------------

# A user service gets a minimal PATH, but the daemon spawns `pnpm dev` /
# `npm run dev`, so node and the package managers must all be reachable.
SERVICE_PATH="$(dirname "${NODE_BIN}")"
for tool in npm pnpm yarn bun; do
  p="$(command -v "${tool}" 2>/dev/null || true)"
  if [ -n "${p}" ]; then SERVICE_PATH="${SERVICE_PATH}:$(dirname "${p}")"; fi
done
# pnpm's default PNPM_HOME, if present (macOS and Linux layouts).
if [ -d "${HOME_DIR}/Library/pnpm" ]; then SERVICE_PATH="${SERVICE_PATH}:${HOME_DIR}/Library/pnpm"; fi
if [ -d "${HOME_DIR}/.local/share/pnpm" ]; then SERVICE_PATH="${SERVICE_PATH}:${HOME_DIR}/.local/share/pnpm"; fi
SERVICE_PATH="${SERVICE_PATH}:${HOME_DIR}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SERVICE_PATH="$(printf '%s' "${SERVICE_PATH}" | awk -v RS=: '!seen[$0]++ { printf "%s%s", sep, $0; sep=":" }')"

# --------------------------------------------------------------------------
# 4. Validate the daemon + seed/scan the registry
# --------------------------------------------------------------------------

info "Validating daemon + registry"

[ -f "${DAEMON}" ] || fail "daemon not found at ${DAEMON}"

if ! "${NODE_BIN}" --check "${DAEMON}"; then
  fail "syntax check failed: ${DAEMON}"
fi
ok "daemon parses cleanly (${DAEMON})"

# Scan the home dir into the state-dir registry (merges, never clobbers hand
# edits). Pin LAZYDEV_STATE_DIR so scan writes where the daemon will read.
if [ -f "${SCANNER}" ]; then
  info "Scanning \$HOME for projects -> ${REGISTRY}"
  if LAZYDEV_STATE_DIR="${STATE_DIR}" "${NODE_BIN}" "${SCANNER}" >/dev/null 2>&1; then
    ok "registry scanned into the state dir"
  else
    warn "scan failed; continuing with whatever registry exists"
  fi
fi

# Guarantee a registry exists even if the scan was skipped or found nothing.
if [ ! -f "${REGISTRY}" ]; then
  printf '%s\n' '{ "port": 80, "idleTimeoutMs": 1800000, "startTimeoutMs": 120000, "projects": [] }' > "${REGISTRY}"
  ok "created empty registry (run 'lazydev scan' to fill it)"
fi

if ! "${NODE_BIN}" -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "${REGISTRY}"; then
  fail "registry is not valid JSON: ${REGISTRY}"
fi
ok "registry is valid JSON (${REGISTRY})"

# Pin the registry's top-level port to the front door (:80). The daemon's unit
# forces LAZYDEV_PORT=80 regardless, but the CLI reads this field to find the
# control port, so keeping them aligned means `lazydev status` hits the right
# port. A shared state dir may carry an old npx-written port; normalize it.
"${NODE_BIN}" -e '
  const fs = require("fs");
  const f = process.argv[1], port = Number(process.argv[2]);
  const reg = JSON.parse(fs.readFileSync(f, "utf8"));
  if (reg.port !== port) {
    reg.port = port;
    fs.writeFileSync(f, JSON.stringify(reg, null, 2) + "\n");
  }
' "${REGISTRY}" "${FRONT_PORT}"
ok "registry front-door port set to :${FRONT_PORT}"

# --------------------------------------------------------------------------
# 5. Write + load the platform service unit
# --------------------------------------------------------------------------

# The unit file path and label come from the pure decision, so install and
# uninstall never drift.
UNIT_PATH="$("${NODE_BIN}" "${RENDER}" path "${PLATFORM}" "${HOME_DIR}" "${XDG_CONFIG_HOME:-}")"
LABEL="$("${NODE_BIN}" "${RENDER}" label "${PLATFORM}" "${HOME_DIR}" "${XDG_CONFIG_HOME:-}")"

if [ "${PLATFORM}" = "darwin" ]; then
  install_macos
else
  install_linux
fi

# --------------------------------------------------------------------------
# 6. Link the CLI onto PATH + wait for the front door
# --------------------------------------------------------------------------

info "Linking CLI -> ${HOME_DIR}/.local/bin/lazydev"
mkdir -p "${HOME_DIR}/.local/bin"
ln -sf "${CONFIG_DIR}/lazydev" "${HOME_DIR}/.local/bin/lazydev"
ok "lazydev CLI linked (make sure ${HOME_DIR}/.local/bin is on your PATH)"

wait_for_front_door || true

print_summary
