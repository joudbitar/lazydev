# architecture

How lazydev is put together, for anyone who wants to change it. The user-facing
story is in [README.md](README.md); this is the internals.

## topology

```
browser  ->  http://<host>.localhost            (e.g. http://webapp.localhost)
         ->  lazydev daemon on :80   (wildcard bind, loopback-only per connection)
               - parse Host header -> project
               - ensure that project's dev server is running (start if cold)
               - reverse-proxy the request (HTTP + WebSocket/HMR) to its port
               - record lastAccess; a reaper sleeps idle projects
         ->  the project's dev server on its own fixed port (e.g. :3000)
```

The daemon is its own front door: it binds the wildcard address on :80 and
destroys any connection that is not from loopback before a byte is read
(ADR 0002). When :80 is unavailable (Linux without CAP_NET_BIND_SERVICE, or a
leftover Caddy from the pre-0003 install still holding the port) it falls back
to :4000 and URLs carry the port. The daemon is the brain: it maps hostnames to
projects, starts and stops dev servers on demand, proxies traffic, and reaps
idle projects. Each dev server runs on its own fixed port. Zero npm
dependencies, Node built-ins only.

The persistent install is a user LaunchAgent written and loaded by
`bin/lazydev.mjs` (ADR 0003): the package is copied to
`~/.local/state/lazydev/app`, the plist points launchd at that copy, and
`lazydev uninstall` reverses all of it.

## files

| File | Purpose |
|------|---------|
| `lazydev.mjs` | the proxy + lifecycle daemon (Node ESM, zero deps) |
| `scan.mjs` | scans `scanRoots` (default `~`) for projects, writes and merges `projects.json` |
| `projects.json` | the registry (gitignored; see `projects.example.json`) |
| `bin/lazydev.mjs` | the entrypoint: consent prompt, scan, launchd install, uninstall |
| `lib/install.mjs` | pure install helpers: plist rendering, launchd PATH, Caddyfile cleanup |
| `serve_static.py` | optional static server with cleanUrls, for static sites |
| `.claude/skills/add-project/` | agent skill for registering what the scanner can't prove; ships in the package, installed to `~/.claude/skills` |
| `logs/` | runtime: `daemon.log` plus `<host>.log` per project |

## registry schema

`projects.json` is the single source of truth for what lazydev knows.

```json
{
  "port": 4000,
  "idleTimeoutMs": 1800000,
  "startTimeoutMs": 120000,
  "scanExclude": ["/archive/"],
  "projects": [
    {
      "host": "webapp",
      "dir": "/Users/you/code/webapp",
      "port": 3000,
      "startCmd": "pnpm dev",
      "framework": "next",
      "enabled": true
    }
  ]
}
```

Top level:

- `port` is the daemon's fallback port (default 4000, used when :80 cannot be bound; the installed plist forces the front door via `LAZYDEV_PORT`).
- `idleTimeoutMs` is how long a project can sit untouched before the reaper sleeps it.
- `startTimeoutMs` is how long the daemon waits for a cold server to answer before giving up.
- `scanExclude` is an optional list of path substrings `scan` skips, pruned during the walk itself so it covers every ecosystem and everything under the excluded path.
- `scanRoots` is an optional list of directories `scan` walks, default `["~"]`. `~` and `~/` prefixes expand to the home directory; relative paths and roots nested inside another root are ignored. A rescan writes the list back exactly as you wrote it.

Per project:

- `host` is the subdomain label. The URL is `http://<host>.localhost`. Must be unique.
- `dir` is the absolute project directory. It may contain spaces, so it is passed as `cwd`, never interpolated into a shell string.
- `port` is the fixed port lazydev runs, health-checks, and proxies this project on.
- `startCmd` is the command run with `cwd=dir`. The daemon injects `PORT=<port>` into the environment. Vite ignores `PORT`, so Vite start commands must pass `--port <port> --strictPort` explicitly.
- `framework` is one of `next | vite | cra | astro | remix | sveltekit | node | rails | django | static`, informational.
- `enabled` false keeps the project registered but parked; the daemon returns a disabled page and never starts it. Scanned static folders start parked.

## scanning

`scan` walks each root in `scanRoots`, four levels deep, and registers a
directory only when both the framework and the start command are provable from
marker files alone. Anything short of proof is the add-project skill's job: a
wrong startCmd executes arbitrary code every time its URL is visited.

- node: a `package.json` whose `dev` script looks like a web server. The
  original case, unchanged.
- rails: `Gemfile` plus `bin/rails` plus `config/application.rb`. Engines and
  gems have the first two; only an app has the third. Start command
  `bin/rails server -p <port>`.
- django: a `manage.py` that mentions django, plus a provable interpreter:
  `.venv/bin/python`, `venv/bin/python`, a `uv.lock` (`uv run python`), or a
  `poetry.lock` (`poetry run python`). No interpreter evidence means no entry,
  because a bare `python` can silently run the wrong environment. The port is
  written into the command; django ignores `PORT`.
- static: an `index.html` at the root of its own git repo, with no
  `package.json` and no marker of another ecosystem (`Cargo.toml`, `go.mod`,
  `pyproject.toml`, ...). The `.git` requirement is what keeps docs folders,
  build output, and downloaded templates out. Start command is the repo's
  `serve_static.py`, which reads `PORT`. These register with
  `"enabled": false`, since the remaining look-alikes are indistinguishable on
  disk; the dashboard shows them parked until the user flips the flag.

rails and django win over a `package.json` in the same directory: `manage.py`
and `bin/rails` name the app, and the package.json beside them is asset
tooling. Any detected root ends the walk down that path, so workspaces and
embedded frontends are not registered separately.

Cost rule for new detectors: the walk visits thousands of directories, so
first-gate checks must be lookups against the directory listing the walk
already holds; stat and read calls are allowed only after a first marker hits.
A warm rescan stays around two seconds.

## host resolution

Given the incoming `Host` header:

1. Strip any `:port` suffix and a trailing `.localhost`.
2. Bare `localhost` and IP literals (`127.0.0.1`, `[::1]`) name no project: they
   get the dashboard, so pasting the daemon's address into a browser lands
   somewhere useful.
3. Of the remaining dot-separated labels, the project key is the last one.
   - `webapp.localhost` resolves to `webapp`
   - `tenant.webapp.localhost` also resolves to `webapp`, and the original Host header is preserved upstream so the app's own multi-tenant logic still sees `tenant`
4. Look up an enabled project whose `host` equals that key. A miss returns a friendly page listing the available `*.localhost` URLs.

That last-label rule is how `tenant.webapp.localhost` and `webapp.localhost` land on the same project.

## lifecycle notes

- Dev servers spawn as process-group leaders, so sleeping a project kills the whole tree with one signal (the package manager, the framework under it, its workers). Nothing is left squatting the port.
- Health probes try both loopbacks. On some machines `localhost` resolves only to `::1`, and plenty of dev servers listen on one family only, so the daemon probes `127.0.0.1` and `::1` separately.
- `scan` merges instead of overwriting: it preserves the port, start command, and enabled flag of any host already in the registry, and only assigns fresh ports to newly discovered projects. Hand-added entries whose directory still exists are carried through untouched.
