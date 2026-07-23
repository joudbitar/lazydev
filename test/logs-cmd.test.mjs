// `lazydev logs <host>` — the command every redacted status page points at.
// The daemon hides log tails from unauthorized browsers, so this CLI read is
// the sanctioned way to see WHY a start failed; it must work with the daemon
// wedged, dead, or never installed. These tests spawn the real entrypoint
// against a temp state dir — the same code path a user's shell runs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const BIN = path.join(ROOT, 'bin', 'lazydev.mjs');
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'lazydev-logs-'));
const LOGS = path.join(STATE, 'logs');
after(() => fs.rmSync(STATE, { recursive: true, force: true }));

function run(args) {
  const r = spawnSync(process.execPath, [BIN, 'logs', ...args], {
    env: {
      ...process.env,
      LAZYDEV_STATE_DIR: STATE,
      NO_COLOR: '1', // plain output — assertions read exact text
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('no host: prints usage, exits 0 (asking how is not an error)', () => {
  const r = run([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage: lazydev logs <host>/);
});

test('unknown host: says so, lists what exists, exits 1', () => {
  fs.mkdirSync(LOGS, { recursive: true });
  fs.writeFileSync(path.join(LOGS, 'someproj.log'), 'line\n');
  const r = run(['nope']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /no log for nope yet/);
  assert.match(r.stdout, /someproj/);
});

test('tails the last -n lines of the host log', () => {
  fs.mkdirSync(LOGS, { recursive: true });
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`);
  fs.writeFileSync(path.join(LOGS, 'proj.log'), lines.join('\n') + '\n');
  const r = run(['proj', '-n', '10']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /last 10 of 50 lines/);
  assert.ok(r.stdout.includes('line-50'), 'newest line present');
  assert.ok(r.stdout.includes('line-41'), 'tenth-from-last present');
  assert.ok(!r.stdout.includes('line-40\n'), 'older lines cut');
});

test('accepts the URL form: host.localhost maps to the same log', () => {
  const r = run(['proj.localhost', '-n', '5']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /proj\.log/);
  assert.ok(r.stdout.includes('line-50'));
});

test('path traversal in the host is rejected as usage, exit 1', () => {
  const r = run(['../secrets']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /usage: lazydev logs <host>/);
});
