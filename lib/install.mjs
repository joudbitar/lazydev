// lazydev persistent-install helpers — the pure half of "one command installs".
//
// The npx entrypoint (bin/lazydev.mjs) is the only install path: it scans,
// copies the app into the state dir, writes a launchd plist, and loads it.
// Everything here is pure (strings in, strings out) so the plist shape, the
// launchd PATH assembly, and the Caddyfile cleanup are testable without
// touching launchctl or the filesystem. The impure orchestration lives in
// bin/lazydev.mjs.

// The one launchd label lazydev has ever used. Reusing it means an npx install
// on a machine with the old checkout install REPLACES the agent instead of
// fighting it — one lazydev per machine.
export const LAUNCHD_LABEL = 'com.lazydev.proxy';

export function escapeXml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// Assemble the PATH a launchd-spawned daemon needs. launchd hands processes a
// minimal PATH, but the daemon spawns `pnpm dev` / `npm run dev`, so node and
// the package managers must all be reachable. toolDirs are the directories of
// the tools found on THIS machine (node itself, npm/pnpm/yarn/bun); the
// standard system dirs are appended, and duplicates collapse in first-seen
// order — same rule as the old install.sh awk pass.
export function assembleLaunchdPath({ toolDirs = [], home }) {
  const dirs = [
    ...toolDirs,
    `${home}/Library/pnpm`,
    `${home}/.local/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out.join(':');
}

// Render the LaunchAgent plist. The daemon is started from the app copy inside
// the state dir, with LAZYDEV_STATE_DIR pinned so registry, logs, and control
// token all land in ONE directory, and LAZYDEV_PORT=80 so it serves the front
// door directly (wildcard bind + loopback guard, ADR 0002). If something else
// owns :80 — including a legacy Caddy install, which keeps proxying
// *.localhost to :4000 — the daemon's own bind fallback lands it on the
// fallback port and everything still works.
export function renderPlist({
  label = LAUNCHD_LABEL,
  nodeBin,
  daemonPath,
  workDir,
  stateDir,
  logsDir,
  home,
  pathEnv,
  frontPort = 80,
  fallbackPort = 4000,
}) {
  const e = escapeXml;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${e(label)}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${e(nodeBin)}</string>
        <string>${e(daemonPath)}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>WorkingDirectory</key>
    <string>${e(workDir)}</string>

    <key>StandardOutPath</key>
    <string>${e(logsDir)}/daemon.out</string>

    <key>StandardErrorPath</key>
    <string>${e(logsDir)}/daemon.err</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${e(home)}</string>
        <key>PATH</key>
        <string>${e(pathEnv)}</string>
        <key>LAZYDEV_STATE_DIR</key>
        <string>${e(stateDir)}</string>
        <key>LAZYDEV_PORT</key>
        <string>${e(String(frontPort))}</string>
        <key>LAZYDEV_FALLBACK_PORT</key>
        <string>${e(String(fallbackPort))}</string>
    </dict>
</dict>
</plist>
`;
}

// Pull the WorkingDirectory out of a launchd plist. The pre-ADR-0003 install
// ran the daemon from its checkout, with projects.json in that directory; the
// plist is the one durable pointer to where that was. Used by the installer to
// migrate the old registry (hand-added entries can't be rediscovered by a
// scan) into the state dir. Returns null when the text has no such key.
export function extractWorkingDirectory(plistText) {
  const m = String(plistText).match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/);
  return m ? m[1] : null;
}

// Remove the lazydev-managed block from a Caddyfile's text. Handles both the
// sentinel form the last installer wrote (between the >>> and <<< marker
// lines) and the legacy form (a `# Managed by lazydev` comment through the
// following closing `}`). Returns { text, changed } and never touches other
// sites in the file. Used by `lazydev uninstall` to clean a machine that was
// installed the old Caddy way.
export function stripCaddyBlock(text) {
  const lines = String(text).split('\n');
  const out = [];
  let inSentinel = false;
  let inLegacy = false;
  let changed = false;
  for (const line of lines) {
    if (/^# >>> lazydev managed block >>>/.test(line)) {
      inSentinel = true;
      changed = true;
      continue;
    }
    if (inSentinel) {
      if (/^# <<< lazydev managed block <<</.test(line)) inSentinel = false;
      continue;
    }
    if (/^# Managed by lazydev/.test(line)) {
      inLegacy = true;
      changed = true;
      continue;
    }
    if (inLegacy) {
      if (/^}/.test(line)) inLegacy = false;
      continue;
    }
    out.push(line);
  }
  return { text: out.join('\n'), changed };
}
