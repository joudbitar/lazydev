// lazydev service-unit decisions — the pure half of "how does the persistent
// install register the daemon as a user service on each platform".
//
// The installer (install.sh) and uninstaller (uninstall.sh) are bash, but the
// interesting decisions are the same three pure functions on both platforms:
//   detectPlatform(uname)   Darwin | Linux | other
//   servicePaths(...)       where the unit file lives, and its label
//   renderLaunchdPlist(...) the macOS LaunchAgent XML
//   renderSystemdUnit(...)  the Linux systemd USER unit
//
// The daemon serves the front door directly on :80 (no Caddy — see
// docs/adr/0001-npx-front-door.md), so both units run the SAME daemon against
// the SAME state directory. macOS lets an unprivileged process bind :80; Linux
// does not without CAP_NET_BIND_SERVICE, so the systemd unit grants that
// capability. If it cannot be granted the daemon falls back to a numbered port
// on its own (lib/bind.mjs), so nothing here has to special-case that.
//
// Pure: no fs, no child_process, no import-time side effects. The shell scripts
// call these through `node -e`/`node <script>` to render the exact file bytes,
// and the node --test suite exercises them directly. Zero npm dependencies.

// The launchd label / systemd unit basename. Single-sourced so install and
// uninstall never drift on the name they load and remove.
export const SERVICE_LABEL = 'com.lazydev.proxy';
export const SYSTEMD_UNIT_NAME = 'lazydev.service';

// The front-door port the persistent daemon serves on, and the numbered port it
// falls back to when :80 cannot be bound. Both units export these so the
// installed daemon serves :80 regardless of the registry's top-level port
// (which a prior npx run on a shared state dir may have set to something else),
// and so the fallback matches the npx path. See docs/adr/0001-npx-front-door.md.
export const FRONT_PORT = 80;
export const FALLBACK_PORT = 4000;

// Map `uname -s` output to the platform we branch on. Anything we do not have a
// persistent-install path for comes back as 'other' so the caller can refuse
// cleanly instead of writing a plist onto, say, a BSD.
//
//   'Darwin'  -> 'darwin'   (launchd)
//   'Linux'   -> 'linux'    (systemd user unit)
//   anything else -> 'other'
export function detectPlatform(uname) {
  const s = String(uname || '').trim().toLowerCase();
  if (s === 'darwin') return 'darwin';
  if (s === 'linux') return 'linux';
  return 'other';
}

// Where the service unit lives, and the label/name used to load and remove it.
// One place so install and uninstall agree byte-for-byte on the path.
//
//   platform   'darwin' | 'linux' (from detectPlatform)
//   home       the user's home directory (absolute)
//   xdgConfigHome  $XDG_CONFIG_HOME if set, else '' — Linux only; when empty the
//                  default ~/.config is used, matching systemd's own default.
//
// Returns { platform, unitPath, label } — label is the launchd label on macOS
// and the unit name on Linux, i.e. the string you pass to launchctl / systemctl.
export function servicePaths({ platform, home = '', xdgConfigHome = '' } = {}) {
  if (platform === 'darwin') {
    return {
      platform,
      unitPath: joinPath(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`),
      label: SERVICE_LABEL,
    };
  }
  if (platform === 'linux') {
    const base = String(xdgConfigHome || '').trim()
      ? String(xdgConfigHome).trim()
      : joinPath(home, '.config');
    return {
      platform,
      unitPath: joinPath(base, 'systemd', 'user', SYSTEMD_UNIT_NAME),
      label: SYSTEMD_UNIT_NAME,
    };
  }
  return { platform: 'other', unitPath: '', label: '' };
}

// Minimal POSIX path join (no node:path import so this stays importable in the
// tiniest contexts and has one obvious behavior). Drops empty segments, keeps a
// single separator, preserves a leading '/'.
function joinPath(...parts) {
  const segs = parts.map((p) => String(p == null ? '' : p)).filter((p) => p !== '');
  const joined = segs.join('/').replace(/\/{2,}/g, '/');
  return joined;
}

// Render the macOS LaunchAgent plist. The daemon binds :80 directly (macOS
// allows the unprivileged bind), so there is NO Caddy. LAZYDEV_PORT=80 pins the
// front door regardless of the registry's top-level port, and
// LAZYDEV_FALLBACK_PORT matches the npx fallback if :80 is ever unavailable.
//
//   nodeBin    absolute path to the node binary that runs the daemon
//   daemon     absolute path to lazydev.mjs
//   workingDir the daemon's cwd (the checkout root)
//   stateDir   the state directory (registry, logs, control token live here)
//   logsDir    where StandardOut/StandardError go (inside the state dir)
//   home       the user's home directory (exported as HOME to the daemon)
//   pathEnv    the PATH the daemon inherits (must reach node + package managers)
//
// A trailing newline is included so the file ends cleanly.
export function renderLaunchdPlist({ nodeBin, daemon, workingDir, stateDir, logsDir, home, pathEnv } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        <string>${daemon}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>WorkingDirectory</key>
    <string>${workingDir}</string>

    <key>StandardOutPath</key>
    <string>${logsDir}/daemon.out</string>

    <key>StandardErrorPath</key>
    <string>${logsDir}/daemon.err</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${home}</string>
        <key>PATH</key>
        <string>${pathEnv}</string>
        <key>LAZYDEV_STATE_DIR</key>
        <string>${stateDir}</string>
        <key>LAZYDEV_PORT</key>
        <string>${FRONT_PORT}</string>
        <key>LAZYDEV_FALLBACK_PORT</key>
        <string>${FALLBACK_PORT}</string>
    </dict>
</dict>
</plist>
`;
}

// Render the Linux systemd USER unit. AmbientCapabilities + CapabilityBoundingSet
// grant the daemon CAP_NET_BIND_SERVICE so an unprivileged user service can bind
// :80. If the running systemd cannot grant it, the daemon's own bind fallback
// (lib/bind.mjs) drops to a numbered port, so the unit does not have to.
//
//   nodeBin    absolute path to the node binary
//   daemon     absolute path to lazydev.mjs
//   workingDir the daemon's cwd (the checkout root)
//   stateDir   the state directory, exported as LAZYDEV_STATE_DIR
//   pathEnv    the PATH the daemon inherits (must reach node + package managers)
//
// ExecStart is not quoted: systemd splits on whitespace, and both paths are
// absolute with no spaces on a normal install; the caller validates that.
// A trailing newline is included so the file ends cleanly.
export function renderSystemdUnit({ nodeBin, daemon, workingDir, stateDir, pathEnv } = {}) {
  return `[Unit]
Description=lazydev on-demand local dev-server proxy
Documentation=https://github.com/joudbitar/lazydev
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${daemon}
WorkingDirectory=${workingDir}
Environment=LAZYDEV_STATE_DIR=${stateDir}
Environment=LAZYDEV_PORT=${FRONT_PORT}
Environment=LAZYDEV_FALLBACK_PORT=${FALLBACK_PORT}
Environment=PATH=${pathEnv}
# Bind :80 as an unprivileged user service. If systemd cannot grant this, the
# daemon falls back to a numbered port on its own (see lib/bind.mjs).
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}
