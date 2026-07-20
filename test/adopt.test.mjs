// Port-ownership verification tests for the adopt-or-conflict decision.
//
// Before adopting a listener lazydev did not spawn, the daemon resolves the
// listening PID's cwd and compares it to project.dir. Match -> adopt (external);
// mismatch -> a visible `conflict` state that is NEVER proxied; unresolved cwd
// (e.g. lsof missing) -> degrade to the legacy adopt. These tests prove all
// three paths end-to-end (real daemon, real proxied HTTP) plus the pure sameDir
// helper. The PID->cwd resolver is swapped via __setResolvePidCwd so no real
// lsof runs — deterministic in CI. No real projects, no fixed ports.

import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// LAZYDEV_CONFIG is read at module load, so the temp registry must exist and the
// env var must point at it BEFORE importing lazydev.mjs. node --test runs the
// whole file in one process, so we set both at top-level here.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lazydev-adopt-'));
const CONFIG_PATH = path.join(TMP_ROOT, 'projects.json');
// A real directory to use as the matching project.dir (so realpath in sameDir
// has something to resolve). The mismatching case uses a bogus path on purpose.
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lazydev-projdir-'));

// The registry port is rewritten per-test to the fake server's OS-assigned port.
function writeRegistry(port, dir) {
  const registry = {
    port: 0, // daemon listen port is irrelevant here; we listen on an ephemeral port
    projects: [
      { host: 'proj', dir, port, startCmd: 'true', enabled: true, framework: 'node' },
    ],
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(registry));
}

// Seed a placeholder so the import-time load doesn't warn; real values per-test.
writeRegistry(0, PROJECT_DIR);
process.env.LAZYDEV_CONFIG = CONFIG_PATH;

const { createDaemonServer, loadConfig, sameDir, __setResolvePidCwd } = await import('../lazydev.mjs');

// Listen on an OS-assigned loopback port; resolve the actual port.
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// GET path over a fresh 127.0.0.1 connection with a Host header; resolve
// { status, body }. 127.0.0.1 so the daemon's loopback guard admits the request.
function httpGet(port, hostHeader, reqPath = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: reqPath, headers: { host: hostHeader } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function httpPost(port, hostHeader, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: reqPath, headers: { host: hostHeader } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// A fake dev server that records how many requests it received. `port` is
// OS-assigned; the registry points a project at it.
function fakeDevServer(bodyText) {
  let count = 0;
  const srv = http.createServer((req, res) => {
    count += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(bodyText);
  });
  return {
    srv,
    get count() {
      return count;
    },
  };
}

function statusFor(port, host) {
  return httpGet(port, 'lazydev.localhost', '/__lazydev/status').then((r) => {
    const parsed = JSON.parse(r.body);
    return parsed.projects.find((p) => p.host === host);
  });
}

before(() => {
  loadConfig('adopt-test');
});

// Reset the injected resolver after each test so overrides never leak.
afterEach(() => {
  __setResolvePidCwd(null); // null -> restores defaultResolvePidCwd
});

test('A: sameDir normalizes trailing slash and . segments', () => {
  assert.equal(sameDir('/a/b', '/a/b/'), true);
  assert.equal(sameDir('/a/b/', '/a/b'), true);
  assert.equal(sameDir('/a/b', '/a/./b'), true);
  assert.equal(sameDir('/a/b', '/a/c'), false);
  assert.equal(sameDir('/a/b', '/a/b/c'), false);
  assert.equal(sameDir('', '/a/b'), false);
  assert.equal(sameDir('/a/b', ''), false);
});

test('B: external listener with matching cwd is adopted and proxied', async (t) => {
  const fake = fakeDevServer('hello-from-fake');
  const fakePort = await listen(fake.srv);
  writeRegistry(fakePort, PROJECT_DIR);
  loadConfig('test-B');

  // Fake resolver: the listener's cwd equals project.dir -> match -> adopt.
  __setResolvePidCwd(() => PROJECT_DIR);

  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(() => {
    daemon.close();
    fake.srv.close();
  });

  const res = await httpGet(daemonPort, 'proj.localhost', '/');
  assert.equal(res.status, 200, `expected proxied 200, got ${res.status}`);
  assert.equal(res.body, 'hello-from-fake', 'body should be the fake server response');
  assert.ok(fake.count >= 1, 'fake server should have received the proxied request');

  const entry = await statusFor(daemonPort, 'proj');
  assert.equal(entry.state, 'running', 'adopted external server is running');
  assert.equal(entry.owned, false, 'adopted external server is not owned');
  assert.equal(entry.conflict, false, 'adopted server is not a conflict');
});

test('C: external listener with mismatching cwd is a conflict, never proxied', async (t) => {
  const fake = fakeDevServer('hello-from-fake');
  const fakePort = await listen(fake.srv);
  writeRegistry(fakePort, '/some/project/dir');
  loadConfig('test-C');

  // Fake resolver: the listener's cwd differs from project.dir -> conflict.
  __setResolvePidCwd(() => '/totally/different/dir');

  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(() => {
    daemon.close();
    fake.srv.close();
  });

  const res = await httpGet(daemonPort, 'proj.localhost', '/');
  assert.equal(res.status, 502, `conflict should surface as 502, got ${res.status}`);
  assert.notEqual(res.body, 'hello-from-fake', 'must NOT return the foreign server body');
  assert.equal(fake.count, 0, 'the foreign server must NEVER be proxied to');

  const entry = await statusFor(daemonPort, 'proj');
  assert.equal(entry.state, 'conflict', 'state is conflict');
  assert.equal(entry.owned, false, 'conflict is not owned');
  assert.equal(entry.conflict, true, 'conflict convenience flag is set');
  assert.equal(entry.conflictDir, '/totally/different/dir', 'conflictDir records the foreign cwd');

  // The `up` control endpoint reports the conflict reason.
  const up = await httpPost(daemonPort, 'lazydev.localhost', '/__lazydev/up/proj');
  const upBody = JSON.parse(up.body);
  assert.equal(upBody.ok, false, 'up should fail on conflict');
  assert.equal(upBody.reason, 'PORT_CONFLICT', 'up reports PORT_CONFLICT');

  // Still zero requests to the foreign server after the up attempt.
  assert.equal(fake.count, 0, 'up attempt must not proxy to the foreign server either');
});

test('D: unresolved cwd (lsof unavailable) degrades to legacy adopt', async (t) => {
  const fake = fakeDevServer('hello-from-fake');
  const fakePort = await listen(fake.srv);
  writeRegistry(fakePort, '/some/project/dir');
  loadConfig('test-D');

  // Fake resolver returns null: cwd unknowable -> legacy adopt, still proxies.
  __setResolvePidCwd(() => null);

  const daemon = createDaemonServer();
  const daemonPort = await listen(daemon);
  t.after(() => {
    daemon.close();
    fake.srv.close();
  });

  const res = await httpGet(daemonPort, 'proj.localhost', '/');
  assert.equal(res.status, 200, `fallback adopt should proxy (200), got ${res.status}`);
  assert.equal(res.body, 'hello-from-fake', 'fallback adopt proxies the server body');
  assert.ok(fake.count >= 1, 'fallback adopt reaches the server');

  const entry = await statusFor(daemonPort, 'proj');
  assert.equal(entry.state, 'running', 'fallback adopt is running');
  assert.equal(entry.owned, false, 'fallback adopt is external (not owned)');
  assert.equal(entry.conflict, false, 'fallback adopt is not a conflict');
});
