// Unit tests for lib/install.mjs — the pure half of the one-command install.
// Zero deps: node:test + built-ins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAUNCHD_LABEL, assembleLaunchdPath, renderPlist, stripCaddyBlock, extractWorkingDirectory } from '../lib/install.mjs';

test('assembleLaunchdPath dedupes in first-seen order and appends system dirs', () => {
  const p = assembleLaunchdPath({
    toolDirs: ['/opt/node/bin', '/opt/homebrew/bin', '/opt/node/bin'],
    home: '/Users/x',
  });
  const dirs = p.split(':');
  assert.equal(dirs[0], '/opt/node/bin');
  assert.equal(dirs[1], '/opt/homebrew/bin'); // kept where first seen, not re-appended
  assert.equal(new Set(dirs).size, dirs.length, 'no duplicates');
  assert.ok(dirs.includes('/Users/x/.local/bin'));
  assert.ok(dirs.includes('/usr/bin'));
  assert.ok(dirs.includes('/bin'));
});

test('renderPlist pins the state dir, the front door, and the daemon path', () => {
  const plist = renderPlist({
    nodeBin: '/opt/node/bin/node',
    daemonPath: '/Users/x/.local/state/lazydev/app/lazydev.mjs',
    workDir: '/Users/x/.local/state/lazydev/app',
    stateDir: '/Users/x/.local/state/lazydev',
    logsDir: '/Users/x/.local/state/lazydev/logs',
    home: '/Users/x',
    pathEnv: '/opt/node/bin:/usr/bin:/bin',
  });
  assert.ok(plist.includes(`<string>${LAUNCHD_LABEL}</string>`));
  assert.ok(plist.includes('<string>/opt/node/bin/node</string>'));
  assert.ok(plist.includes('<string>/Users/x/.local/state/lazydev/app/lazydev.mjs</string>'));
  assert.ok(plist.includes('<key>LAZYDEV_STATE_DIR</key>'));
  assert.ok(plist.includes('<string>/Users/x/.local/state/lazydev</string>'));
  assert.ok(plist.includes('<key>LAZYDEV_PORT</key>'));
  assert.ok(plist.includes('<string>80</string>'));
  assert.ok(plist.includes('<key>LAZYDEV_FALLBACK_PORT</key>'));
  assert.ok(plist.includes('<string>4000</string>'));
  assert.ok(plist.includes('<key>KeepAlive</key>'));
  assert.ok(plist.includes('<key>RunAtLoad</key>'));
});

test('renderPlist escapes XML-special characters in paths', () => {
  const plist = renderPlist({
    nodeBin: '/odd & strange/<node>',
    daemonPath: '/d',
    workDir: '/w',
    stateDir: '/s',
    logsDir: '/l',
    home: '/h',
    pathEnv: '/a:/b',
  });
  assert.ok(plist.includes('/odd &amp; strange/&lt;node&gt;'));
  assert.ok(!plist.includes('/odd & strange/<node>'));
});

test('stripCaddyBlock removes the sentinel-marked block and nothing else', () => {
  const file = [
    'example.test {',
    '    respond "hi"',
    '}',
    '# >>> lazydev managed block >>>',
    '# Managed by lazydev. *.localhost routes to the daemon.',
    'http://*.localhost, http://*.*.localhost {',
    '    reverse_proxy 127.0.0.1:4000',
    '}',
    '# <<< lazydev managed block <<<',
    'other.test {',
    '    respond "bye"',
    '}',
  ].join('\n');
  const { text, changed } = stripCaddyBlock(file);
  assert.equal(changed, true);
  assert.ok(!text.includes('lazydev'));
  assert.ok(text.includes('example.test {'));
  assert.ok(text.includes('other.test {'));
});

test('stripCaddyBlock removes the legacy comment-through-brace form', () => {
  const file = [
    '# Managed by lazydev',
    'http://*.localhost {',
    '    reverse_proxy 127.0.0.1:4000',
    '}',
    'kept.test {',
    '}',
  ].join('\n');
  const { text, changed } = stripCaddyBlock(file);
  assert.equal(changed, true);
  assert.ok(!text.includes('localhost'));
  assert.ok(text.includes('kept.test {'));
});

test('extractWorkingDirectory round-trips through renderPlist and rejects garbage', () => {
  const plist = renderPlist({
    nodeBin: '/opt/node/bin/node',
    daemonPath: '/d/lazydev.mjs',
    workDir: '/Users/x/lazydev checkout',
    stateDir: '/s',
    logsDir: '/l',
    home: '/Users/x',
    pathEnv: '/a:/b',
  });
  assert.equal(extractWorkingDirectory(plist), '/Users/x/lazydev checkout');
  assert.equal(extractWorkingDirectory('not a plist'), null);
  assert.equal(extractWorkingDirectory(''), null);
});

test('stripCaddyBlock leaves an unmanaged Caddyfile untouched', () => {
  const file = 'a.test {\n    respond "a"\n}\n';
  const { text, changed } = stripCaddyBlock(file);
  assert.equal(changed, false);
  assert.equal(text, file);
});
