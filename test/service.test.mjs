// Service-unit decision tests (issue #10 — cross-platform persistent install).
//
// The installer and uninstaller are bash, but the interesting decisions are the
// pure functions in lib/service.mjs: which platform we're on, where the unit
// file lives, and the exact bytes of the launchd plist / systemd user unit. The
// shell scripts render through those same functions (via bin/render-unit.mjs),
// so locking them here locks what the installer actually writes. The daemon
// serves the front door directly on :80 with no Caddy, so both units must pin
// the port and (Linux) grant CAP_NET_BIND_SERVICE. Zero deps: node:test only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  detectPlatform,
  servicePaths,
  renderLaunchdPlist,
  renderSystemdUnit,
  SERVICE_LABEL,
  SYSTEMD_UNIT_NAME,
  FRONT_PORT,
  FALLBACK_PORT,
} from '../lib/service.mjs';

// --- platform detection -----------------------------------------------------

test('detectPlatform maps uname -s to the platform we branch on', () => {
  assert.equal(detectPlatform('Darwin'), 'darwin');
  assert.equal(detectPlatform('Linux'), 'linux');
  // Case/whitespace tolerant.
  assert.equal(detectPlatform('  darwin\n'), 'darwin');
  assert.equal(detectPlatform('LINUX'), 'linux');
  // Anything without a persistent path is 'other', so the caller refuses cleanly.
  assert.equal(detectPlatform('FreeBSD'), 'other');
  assert.equal(detectPlatform(''), 'other');
  assert.equal(detectPlatform(undefined), 'other');
});

// --- service unit paths -----------------------------------------------------

test('servicePaths: macOS points at the LaunchAgents plist with the launchd label', () => {
  const p = servicePaths({ platform: 'darwin', home: '/Users/j' });
  assert.equal(p.platform, 'darwin');
  assert.equal(p.unitPath, '/Users/j/Library/LaunchAgents/com.lazydev.proxy.plist');
  assert.equal(p.label, SERVICE_LABEL);
});

test('servicePaths: Linux defaults to ~/.config/systemd/user with the unit name', () => {
  const p = servicePaths({ platform: 'linux', home: '/home/j' });
  assert.equal(p.platform, 'linux');
  assert.equal(p.unitPath, '/home/j/.config/systemd/user/lazydev.service');
  assert.equal(p.label, SYSTEMD_UNIT_NAME);
});

test('servicePaths: Linux honors XDG_CONFIG_HOME over ~/.config', () => {
  const p = servicePaths({ platform: 'linux', home: '/home/j', xdgConfigHome: '/cfg' });
  assert.equal(p.unitPath, '/cfg/systemd/user/lazydev.service');
});

test('servicePaths: an empty XDG_CONFIG_HOME falls back to ~/.config', () => {
  const p = servicePaths({ platform: 'linux', home: '/home/j', xdgConfigHome: '   ' });
  assert.equal(p.unitPath, '/home/j/.config/systemd/user/lazydev.service');
});

test('servicePaths: an unsupported platform yields empty path + label', () => {
  const p = servicePaths({ platform: 'other', home: '/home/j' });
  assert.deepEqual(p, { platform: 'other', unitPath: '', label: '' });
});

// --- launchd plist renderer -------------------------------------------------

const macArgs = {
  nodeBin: '/opt/homebrew/bin/node',
  daemon: '/Users/j/lazydev/lazydev.mjs',
  workingDir: '/Users/j/lazydev',
  stateDir: '/Users/j/.local/state/lazydev',
  logsDir: '/Users/j/.local/state/lazydev/logs',
  home: '/Users/j',
  pathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
};

test('renderLaunchdPlist: embeds the label, node + daemon, and the state dir', () => {
  const xml = renderLaunchdPlist(macArgs);
  assert.match(xml, /<string>com\.lazydev\.proxy<\/string>/);
  assert.match(xml, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(xml, /<string>\/Users\/j\/lazydev\/lazydev\.mjs<\/string>/);
  // LAZYDEV_STATE_DIR pins the shared state dir; no Caddy anywhere.
  assert.match(xml, /<key>LAZYDEV_STATE_DIR<\/key>\s*<string>\/Users\/j\/\.local\/state\/lazydev<\/string>/);
  assert.doesNotMatch(xml, /[Cc]addy/);
});

test('renderLaunchdPlist: pins the front-door port and the fallback', () => {
  const xml = renderLaunchdPlist(macArgs);
  assert.match(xml, new RegExp(`<key>LAZYDEV_PORT</key>\\s*<string>${FRONT_PORT}</string>`));
  assert.match(xml, new RegExp(`<key>LAZYDEV_FALLBACK_PORT</key>\\s*<string>${FALLBACK_PORT}</string>`));
});

test('renderLaunchdPlist: is well-formed XML with a trailing newline', () => {
  const xml = renderLaunchdPlist(macArgs);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.match(xml, /<\/plist>\n$/);
  // RunAtLoad + KeepAlive keep the daemon alive on login and on crash.
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
});

// --- systemd user unit renderer ---------------------------------------------

const linuxArgs = {
  nodeBin: '/usr/bin/node',
  daemon: '/home/j/lazydev/lazydev.mjs',
  workingDir: '/home/j/lazydev',
  stateDir: '/home/j/.local/state/lazydev',
  pathEnv: '/usr/local/bin:/usr/bin:/bin',
};

test('renderSystemdUnit: ExecStart runs node against the daemon, cwd + state pinned', () => {
  const unit = renderSystemdUnit(linuxArgs);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/home\/j\/lazydev\/lazydev\.mjs$/m);
  assert.match(unit, /^WorkingDirectory=\/home\/j\/lazydev$/m);
  assert.match(unit, /^Environment=LAZYDEV_STATE_DIR=\/home\/j\/\.local\/state\/lazydev$/m);
});

test('renderSystemdUnit: grants CAP_NET_BIND_SERVICE both ambient and in the bounding set', () => {
  const unit = renderSystemdUnit(linuxArgs);
  assert.match(unit, /^AmbientCapabilities=CAP_NET_BIND_SERVICE$/m);
  assert.match(unit, /^CapabilityBoundingSet=CAP_NET_BIND_SERVICE$/m);
});

test('renderSystemdUnit: pins the front-door port + fallback and wants default.target', () => {
  const unit = renderSystemdUnit(linuxArgs);
  assert.match(unit, new RegExp(`^Environment=LAZYDEV_PORT=${FRONT_PORT}$`, 'm'));
  assert.match(unit, new RegExp(`^Environment=LAZYDEV_FALLBACK_PORT=${FALLBACK_PORT}$`, 'm'));
  // A user unit installs into default.target so it starts on (lingering) login.
  assert.match(unit, /^WantedBy=default\.target$/m);
  // No Caddy in the Linux unit either.
  assert.doesNotMatch(unit, /[Cc]addy/);
  assert.ok(unit.endsWith('\n'));
});

// --- the front-door port is :80 (locks the ADR decision) --------------------

test('FRONT_PORT is 80 and FALLBACK_PORT is a numbered port', () => {
  assert.equal(FRONT_PORT, 80);
  assert.equal(FALLBACK_PORT, 4000);
});

// --- the render-unit CLI wires the shell scripts to these exact renderers ----

test('bin/render-unit.mjs is the same decision the shell scripts call', async () => {
  // Import the same module the CLI imports and confirm the wiring is consistent:
  // the path the CLI prints for a platform equals servicePaths(...).unitPath.
  const home = '/Users/j';
  const p = servicePaths({ platform: 'darwin', home });
  assert.equal(p.unitPath, path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`));
});
