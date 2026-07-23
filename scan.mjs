#!/usr/bin/env node
// lazydev REGISTRY scanner.
// Scans scanRoots (default ~) for projects whose start command is provable
// from marker files alone — Node with a `dev` script, Rails apps, Django with
// a visible interpreter, static folders that are their own repo — and
// writes/merges projects.json per the lazydev BUILD CONTRACT (SPEC.md).
// Everything unprovable is the add-project skill's job, on purpose.
// Zero npm deps — Node built-ins only.

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import os from 'node:os';
import { mergeRegistry } from './lib/registry.mjs';
import { detectRails, detectDjango, detectStatic, normalizeScanRoots, hardcodedPort } from './lib/detect.mjs';
import { resolveStateDir, resolveStatePaths } from './lib/state.mjs';

const HOME = os.homedir();
// Self-locate: the registry lives next to this script (project root) by default,
// not a hardcoded ~/.config path, so the project is relocatable. HOME below is
// still the directory tree we SCAN for projects.
//
// When LAZYDEV_STATE_DIR is set (the npx entrypoint sets it), the registry is
// written into that state dir instead, so scan and the daemon agree on ONE
// location. preferXdg stays false: a bare `node scan.mjs` with no state dir
// keeps the existing next-to-script layout. The per-path LAZYDEV_CONFIG override
// still wins, matching the daemon's own resolution.
const CONFIG_DIR = import.meta.dirname;
const STATE_DIR = resolveStateDir({ env: process.env, home: HOME, scriptDir: CONFIG_DIR, preferXdg: false });
const { configPath: OUT } = resolveStatePaths({ env: process.env, stateDir: STATE_DIR });
const OUT_DIR = dirname(OUT);
const MAXDEPTH = 4;

// Heavy / irrelevant dirs we never descend into.
const SKIP = new Set([
  'node_modules', '.git', 'Library', '.Trash', '.cache', '.npm', '.pnpm-store',
  '.vscode', '.next', 'dist', 'build', '.turbo', 'vendor', '.venv', 'venv',
  '__pycache__', 'Applications', '.local', '.config', '.rustup', '.cargo',
  'go', '.docker', '.ollama', '.android', '.gradle', '.m2', 'Music', 'Movies',
  'Pictures', 'Photos Library.photoslibrary',
]);

// Host name we must never emit (the daemon owns it).
const RESERVED_HOST = 'lazydev';

const POOL_START = 3010;
const POOL_STEP = 10;

// Vite-based frameworks ignore the injected PORT env and must take --port explicitly.
const VITE_BASED = new Set(['vite', 'astro', 'remix', 'sveltekit']);

// A "node"-type dev script only counts as a web/dev server if it looks like one.
const SERVER_HINT = /\b(next|vite|astro|remix|svelte|webpack|serve|start|dev-server|nodemon)\b/;

// ---------------------------------------------------------------------------
// 0. Load the existing registry up front: scan config lives there, and the
//    merge in step 5 preserves everything it already knows.
// ---------------------------------------------------------------------------
let existing = null;
if (existsSync(OUT)) {
  try { existing = JSON.parse(readFileSync(OUT, 'utf8')); } catch { existing = null; }
}
// Optional registry config: path substrings the scanner must skip.
const scanExclude = existing && Array.isArray(existing.scanExclude) ? existing.scanExclude : [];

// ---------------------------------------------------------------------------
// 1. Walk each scan root, collecting project roots. A row's det is null for
//    the package.json path (validated against its dev script in step 4) and a
//    detector result for the non-Node ecosystems.
// ---------------------------------------------------------------------------
const found = [];
const seenDirs = new Set(); // scanRoots may overlap; never register a dir twice
function walk(dir, depth) {
  if (depth > MAXDEPTH) return;
  // scanExclude prunes the walk itself, so it holds for every ecosystem and
  // for everything underneath the excluded path.
  if (scanExclude.some((s) => typeof s === 'string' && s && dir.includes(s))) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const names = new Set(entries.map((e) => e.name));

  // Detection order: rails and django before node, because manage.py and
  // bin/rails name the app itself while a package.json next to them is asset
  // tooling (jsbundling, vite_rails) — registering the bundler would serve
  // the wrong process. Static runs last and never beside a package.json.
  // Any hit is a project root: stop descending, the same rule package.json
  // roots follow today (workspaces and embedded frontends are the
  // add-project skill's job).
  const det = detectRails(dir, names) || detectDjango(dir, names);
  if (det) { addFound(dir, det); return; }
  if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
    addFound(dir, null);
    return;
  }
  const staticDet = detectStatic(dir, names);
  if (staticDet) { addFound(dir, staticDet); return; }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    if (SKIP.has(e.name)) continue;
    walk(join(dir, e.name), depth + 1);
  }
}
function addFound(dir, det) {
  if (seenDirs.has(dir)) return;
  seenDirs.add(dir);
  found.push({ dir, det });
}
// scanRoots: optional registry list of extra (or replacement) scan roots,
// default just ~. Normalization drops relative paths and nested duplicates;
// a root that doesn't exist is skipped, not an error, so a registry shared
// across machines still scans.
const scanRoots = existing && Array.isArray(existing.scanRoots) ? existing.scanRoots : undefined;
for (const root of normalizeScanRoots(scanRoots, HOME)) {
  if (existsSync(root)) walk(root, 0);
}

// ---------------------------------------------------------------------------
// 2. Node detection helpers (the non-Node detectors live in lib/detect.mjs).
// ---------------------------------------------------------------------------
function pmOf(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function frameworkOf(pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.next) return 'next';
  if (deps.vite) return 'vite';
  if (deps['react-scripts']) return 'cra';
  if (deps.astro) return 'astro';
  if (deps['@remix-run/dev']) return 'remix';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  return 'node';
}

function pmRun(pm) {
  switch (pm) {
    case 'pnpm': return 'pnpm dev';
    case 'yarn': return 'yarn dev';
    case 'bun': return 'bun run dev';
    default: return 'npm run dev';
  }
}

function sanitizeHost(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// 3. Build candidate rows. Detector rows pass through as-is; package.json
//    rows still have to prove themselves with a dev script that looks like a
//    web server.
// ---------------------------------------------------------------------------
const candidates = [];
for (const { dir, det } of found) {
  if (det) {
    candidates.push({ dir, name: basename(dir), ...det });
    continue;
  }
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { continue; }
  const dev = pkg.scripts && pkg.scripts.dev;
  if (!dev) continue;
  const framework = frameworkOf(pkg);
  // Plain node project whose dev script doesn't look like a web/dev server.
  if (framework === 'node' && !SERVER_HINT.test(dev)) continue;
  // A PORT-env framework whose dev script pins its own port (`next dev -p
  // 3000`) will bind that port regardless of the injected PORT — register the
  // port the app will actually use, or every start times out. Vite-based
  // scripts are exempt: startCmdFor appends `--port <pool>` after the script's
  // own flags, and last-flag-wins hands the pool port back to us.
  const fixedPort = VITE_BASED.has(framework) ? null : hardcodedPort(dev);
  candidates.push({ dir, name: basename(dir), pm: pmOf(dir), framework, dev, ...(fixedPort ? { fixedPort } : {}) });
}

// ---------------------------------------------------------------------------
// 4. Generate startCmd from a candidate row.
//    Vite-based: "<pmrun> -- --port <port> --strictPort".
//    PORT-env (next/cra/node/static): daemon injects PORT, no port in the cmd.
//    django/rails ignore PORT, so the port is written into the command.
// ---------------------------------------------------------------------------
function startCmdFor(c, port) {
  switch (c.framework) {
    case 'django':
      // Interpreter is evidence-derived (lib/detect.mjs), relative to the
      // project dir the daemon uses as cwd.
      return `${c.interpreter} manage.py runserver 127.0.0.1:${port}`;
    case 'rails':
      return `bin/rails server -p ${port}`;
    case 'static':
      // serve_static.py reads PORT from the env. Quoted because the npx
      // cache path this checkout may live in can contain spaces.
      return `python3 "${join(CONFIG_DIR, 'serve_static.py')}"`;
  }
  const run = pmRun(c.pm);
  if (VITE_BASED.has(c.framework)) {
    return `${run} -- --port ${port} --strictPort`;
  }
  return run;
}

// ---------------------------------------------------------------------------
// 5. Merge with the existing registry (loaded in step 0): assign unique hosts
//    (never RESERVED_HOST), preserve port/enabled/startCmd for known hosts,
//    fresh ports only for new hosts, and carry over hand-added entries whose
//    directory still exists. The merge itself is pure (lib/registry.mjs); we
//    inject the framework-aware helpers and the fs existence check.
// ---------------------------------------------------------------------------
const projects = mergeRegistry({
  existing,
  candidates,
  reservedHost: RESERVED_HOST,
  poolStart: POOL_START,
  poolStep: POOL_STEP,
  startCmdFor,
  sanitizeHost,
  dirExists: existsSync,
});

const out = {
  port: existing && Number.isFinite(existing.port) ? existing.port : 4000,
  idleTimeoutMs: existing && Number.isFinite(existing.idleTimeoutMs) ? existing.idleTimeoutMs : 1800000,
  startTimeoutMs: existing && Number.isFinite(existing.startTimeoutMs) ? existing.startTimeoutMs : 120000,
  ...(scanExclude.length ? { scanExclude } : {}),
  // scanRoots is preserved exactly as the user wrote it (unnormalized), so a
  // rescan never rewrites hand-edited config.
  ...(scanRoots ? { scanRoots } : {}),
  projects,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

// ---------------------------------------------------------------------------
// 6. Report. LAZYDEV_SCAN_QUIET=1 (set by the npx entrypoint, which prints its
//    own banner from the registry) skips the table; a direct `node scan.mjs`
//    or `lazydev scan` keeps it.
// ---------------------------------------------------------------------------
if (process.env.LAZYDEV_SCAN_QUIET === '1') process.exit(0);

const tilde = (p) => p.replace(HOME, '~');
const rows = [...projects].sort((a, b) => a.port - b.port);
const w = {
  host: Math.max('HOST'.length, ...rows.map((r) => r.host.length)),
  port: Math.max('PORT'.length, ...rows.map((r) => String(r.port).length)),
  fw: Math.max('FRAMEWORK'.length, ...rows.map((r) => r.framework.length)),
  cmd: Math.max('STARTCMD'.length, ...rows.map((r) => r.startCmd.length)),
};
console.log(`\nWrote ${rows.length} projects to ${tilde(OUT)}\n`);
console.log(
  '  ' + 'HOST'.padEnd(w.host) + '  ' + 'PORT'.padEnd(w.port) + '  ' +
  'FRAMEWORK'.padEnd(w.fw) + '  ' + 'STARTCMD'.padEnd(w.cmd) + '  ' + 'DIR'
);
for (const r of rows) {
  console.log(
    '  ' + r.host.padEnd(w.host) + '  ' + String(r.port).padEnd(w.port) + '  ' +
    r.framework.padEnd(w.fw) + '  ' + r.startCmd.padEnd(w.cmd) + '  ' + tilde(r.dir)
  );
}
const parked = rows.filter((r) => r.enabled === false).length;
console.log(`\nTotal: ${rows.length} projects.`);
if (parked) {
  console.log(`${parked} parked with "enabled": false (static folders start parked). Flip the flag in ${tilde(OUT)} to serve them.`);
}
console.log('');
