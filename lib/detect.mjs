// lazydev non-Node detectors — the decision half of the scan for projects
// without a package.json.
//
// scan.mjs walks the filesystem and hands each directory here as (dir, names),
// where `names` is the Set of entry names the walk already read for that
// directory. The detectors answer one question: is this a project whose start
// command is provable from marker files alone? Anything short of proof returns
// null; the long tail goes through the add-project skill instead. A wrong
// startCmd executes arbitrary code every time a URL is visited, so the bar is
// proof, not likelihood.
//
// Cost discipline: the walk visits thousands of directories, so the first
// check in every detector is a lookup against the in-memory Set (free).
// stat() and read calls happen only after a first marker hits, which is a
// handful of directories per machine, not thousands.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Rails: Gemfile is the free first gate, then two stats. bin/rails alone is
// not enough — `rails plugin new` generates it for engines and gems too, and
// their bin/rails has no `server` command. Only an app has
// config/application.rb at the root.
export function detectRails(dir, names) {
  if (!names.has('Gemfile')) return null;
  if (!existsSync(join(dir, 'bin', 'rails'))) return null;
  if (!existsSync(join(dir, 'config', 'application.rb'))) return null;
  return { framework: 'rails' };
}

// Django: manage.py plus a provable interpreter. A bare `python` that hopes
// the shell resolves the right one is how the wrong venv (or system Python)
// silently serves a project, so no interpreter evidence means no entry. The
// interpreter requirement also filters cookiecutter templates and abandoned
// checkouts, which have a manage.py but no environment.
export function detectDjango(dir, names) {
  if (!names.has('manage.py')) return null;
  const interpreter = pythonEvidence(dir, names);
  if (!interpreter) return null;
  // manage.py is a de-facto Django name, not a reserved one; the file itself
  // must mention django before we generate a command that runs it.
  try {
    if (!/django/i.test(readFileSync(join(dir, 'manage.py'), 'utf8'))) return null;
  } catch {
    return null;
  }
  return { framework: 'django', interpreter };
}

// Most direct evidence first. uv creates .venv by default, so the lockfile
// branches mostly cover projects whose venv lives somewhere else. Paths are
// relative because the daemon runs startCmd with cwd set to the project dir.
function pythonEvidence(dir, names) {
  for (const venv of ['.venv', 'venv']) {
    if (existsSync(join(dir, venv, 'bin', 'python'))) return `${venv}/bin/python`;
  }
  if (names.has('uv.lock')) return 'uv run python';
  if (names.has('poetry.lock')) return 'poetry run python';
  return null;
}

// Markers of an app in an ecosystem we don't detect. An index.html at the
// root of a Rust or Go repo is a demo page, not a site. Makefile is left off
// on purpose: hand-rolled static sites use one for deploys.
const FOREIGN_MARKERS = [
  'Cargo.toml', 'go.mod', 'composer.json', 'pyproject.toml', 'setup.py',
  'requirements.txt', 'Gemfile', 'manage.py', 'mix.exs', 'pom.xml',
  'build.gradle', 'CMakeLists.txt',
];

// Static folder: index.html at the root of its own git repo. The .git check
// (a dir, or a file in a worktree — both count) carries the weight: docs
// folders, Sphinx and coverage output, and unzipped templates in ~/Downloads
// all have an index.html, and none of them is a repo root. Every check here
// is a Set lookup, zero extra syscalls. Detected sites register parked
// (enabled: false) because the remaining false positives are indistinguishable
// from the real thing on disk; the dashboard shows them until the user flips
// the flag.
export function detectStatic(dir, names) {
  if (!names.has('index.html')) return null;
  if (names.has('package.json')) return null;
  if (!names.has('.git')) return null;
  if (FOREIGN_MARKERS.some((m) => names.has(m))) return null;
  return { framework: 'static', enabled: false };
}

// A dev script that hardcodes its own port — `next dev -p 3000`,
// `react-scripts start --port 4200`, `node server.js --port=8080` — will bind
// that port no matter what PORT the daemon injects. Registering any other port
// for such a project guarantees a start timeout: the app comes up healthy on
// its hardcoded port while the daemon waits on the registered one until the
// clock runs out. So the scanner reads the flag and registers the port the app
// will actually bind. Returns the port number, or null when the script leaves
// the port to the environment.
//
// The flag must be its own token (`-p 3000`, `--port 3000`, `--port=3000`):
// a `-p` glued inside another word (`--no-open`, `top-level`) never matches.
export function hardcodedPort(script) {
  if (typeof script !== 'string') return null;
  const m = script.match(/(?:^|\s)(?:-p|--port)(?:=|\s+)(\d{1,5})(?=\s|$)/);
  if (!m) return null;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535 ? port : null;
}

// scanRoots: optional registry list of directories to scan, default ['~'].
// Only absolute paths survive (after ~ expansion): a relative root would mean
// the registry's contents depend on where the scanner happened to run. Roots
// nested inside another kept root are dropped so overlapping config cannot
// walk the same tree twice.
export function normalizeScanRoots(raw, home) {
  const list = Array.isArray(raw) && raw.length ? raw : ['~'];
  const expanded = [];
  for (const r of list) {
    if (typeof r !== 'string' || !r) continue;
    let p = r === '~' ? home : r.startsWith('~/') ? join(home, r.slice(2)) : r;
    p = p.length > 1 ? p.replace(/\/+$/, '') : p;
    if (!p.startsWith('/')) continue;
    expanded.push(p);
  }
  const uniq = [...new Set(expanded)];
  return uniq.filter((p) => !uniq.some((q) => q !== p && (q === '/' || p.startsWith(q + '/'))));
}
