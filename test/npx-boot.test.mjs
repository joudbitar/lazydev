// Boot smoke for the npx entrypoint (issue #9).
//
// Runs the REAL bin/lazydev.mjs the way `npx lazydev` would, but forced onto a
// non-privileged port so CI (which cannot bind :80) works. It points the state
// dir and HOME at temp trees, plants ONE discoverable project whose dev server
// is a trivial node listener, and asserts:
//   - the entrypoint scans, writes the registry INTO the state dir, and boots;
//   - http://<host>.localhost:<port> proxies to the planted dev server;
//   - nothing was written into the project directory or the checkout — every
//     artifact (registry, logs, control token) landed in the state dir.
// Then Ctrl-C (SIGINT) stops it cleanly. Zero deps: node:test + built-ins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'lazydev.mjs');

// A free 127.0.0.1 port (opened then closed), for forcing a non-privileged
// front door the daemon can actually bind under a test runner.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// GET path via the daemon on 127.0.0.1:port with a Host header. Resolves
// { status, body }.
function get(hostHeader, port, reqPath = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: reqPath, headers: { host: hostHeader } },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Poll until predicate(get result) is true or timeout.
async function poll(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fn();
      if (r) return r;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

test('npx entrypoint scans, boots on a forced port, and proxies to a discovered project', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazydev-npx-state-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazydev-npx-home-'));

  // Plant ONE discoverable project under the temp HOME: a package.json with a
  // `dev` script whose name looks like a server (so scan keeps it), and a
  // node_modules dir so ensureUp skips `npm install`. The dev script is a node
  // one-liner that listens on the injected PORT and answers a fixed body — no
  // framework, no deps, deterministic.
  const projDir = path.join(homeDir, 'demoapp');
  fs.mkdirSync(path.join(projDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(projDir, 'package.json'),
    JSON.stringify({
      name: 'demoapp',
      scripts: {
        // `dev-server` keyword satisfies scan's SERVER_HINT for a plain node project.
        dev: `node -e "require('http').createServer((q,s)=>s.end('DEMO-OK')).listen(process.env.PORT,'127.0.0.1');/*dev-server*/"`,
      },
    })
  );

  const frontPort = await freePort();

  const child = spawn(process.execPath, [BIN], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: homeDir, // scan walks HOME; keep it tiny and contained
      LAZYDEV_STATE_DIR: stateDir,
      LAZYDEV_PORT: String(frontPort), // force a bindable non-privileged front door
      LAZYDEV_FALLBACK_PORT: String(frontPort),
      // Fail a stuck start fast so the test can't hang on a bad spawn.
      LAZYDEV_REAP_INTERVAL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));

  t.after(async () => {
    try {
      child.kill('SIGINT');
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 400));
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  // Wait for the daemon to answer on the front port (dashboard control plane).
  const up = await poll(async () => {
    const r = await get('lazydev.localhost', frontPort);
    return r && r.status ? r : null;
  }, 10000);
  assert.ok(up, `daemon should answer on 127.0.0.1:${frontPort}\n--- child output ---\n${out}`);

  // The scan wrote the registry INTO the state dir (not the checkout, not the
  // project dir), and it discovered our planted project.
  const regPath = path.join(stateDir, 'projects.json');
  assert.ok(fs.existsSync(regPath), 'registry written into the state dir');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  const demo = (reg.projects || []).find((p) => p.host === 'demoapp');
  assert.ok(demo, `planted project discovered by scan (got hosts: ${(reg.projects || []).map((p) => p.host).join(',')})`);

  // Hit the project through the daemon: the first cold hit spawns the dev server
  // (cwd == projDir, so no adopt/conflict), then subsequent hits proxy to it.
  const proxied = await poll(async () => {
    const r = await get('demoapp.localhost', frontPort);
    return r && r.status === 200 && r.body === 'DEMO-OK' ? r : null;
  }, 12000);
  assert.ok(proxied, `proxy reached the spawned dev server at demoapp.localhost:${frontPort}\n--- child output ---\n${out}`);

  // Nothing was written into the project directory beyond what we planted: no
  // registry, no control token, no logs dir leaked into it.
  assert.ok(!fs.existsSync(path.join(projDir, 'projects.json')), 'no registry in the project dir');
  assert.ok(!fs.existsSync(path.join(projDir, 'control-token')), 'no control token in the project dir');
  assert.ok(!fs.existsSync(path.join(projDir, 'logs')), 'no logs dir in the project dir');

  // Everything landed in the state dir instead.
  assert.ok(fs.existsSync(path.join(stateDir, 'control-token')), 'control token in the state dir');
  assert.ok(fs.existsSync(path.join(stateDir, 'logs')), 'logs dir in the state dir');

  // SIGINT stops the daemon cleanly (its own handler exits 0). Give it a moment
  // and assert the process ended without us having to SIGKILL.
  child.kill('SIGINT');
  const exited = await new Promise((resolve) => {
    let done = false;
    child.once('exit', () => {
      done = true;
      resolve(true);
    });
    setTimeout(() => resolve(done), 3000);
  });
  assert.ok(exited, 'entrypoint exits on SIGINT');
});
