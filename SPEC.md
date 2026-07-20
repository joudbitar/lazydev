# architecture

How lazydev is put together, for anyone who wants to change it. The user-facing
story is in [README.md](README.md); this is the internals.

## topology

```
browser  ->  http://<host>.localhost            (e.g. http://webapp.localhost)
         ->  lazydev daemon on :80
               - parse Host header -> project
               - ensure that project's dev server is running (start if cold)
               - reverse-proxy the request (HTTP + WebSocket/HMR) to its port
               - record lastAccess; a reaper sleeps idle projects
         ->  the project's dev server on its own fixed port (e.g. :3000)
```

The daemon serves the front door itself on port 80. There is no Caddy and no
second proxy: the daemon terminates :80, maps hostnames to projects, starts and
stops dev servers on demand, proxies HTTP and WebSocket/HMR traffic, and reaps
idle projects. Each dev server runs on its own fixed port. The daemon has zero
npm dependencies, Node built-ins only. See
[docs/adr/0001-npx-front-door.md](docs/adr/0001-npx-front-door.md) for why the
daemon owns the front door directly.

Binding :80 is not uniform across platforms. macOS lets an unprivileged process
bind it. Linux does not without `CAP_NET_BIND_SERVICE`, so a plain `npx lazydev`
on Linux falls back to a numbered port and prints URLs with the port included
(`http://webapp.localhost:7420`); the persistent Linux service (a systemd user
unit) grants the capability so it binds :80. Whatever port it lands on, the
daemon binds only the loopback families (127.0.0.1 and ::1) and 403s any request
that did not arrive on a loopback address.

## files

| File | Purpose |
|------|---------|
| `lazydev.mjs` | the proxy + lifecycle daemon (Node ESM, zero deps) |
| `bin/lazydev.mjs` | the `npx lazydev` entrypoint: scan + foreground daemon on the front door |
| `bin/render-unit.mjs` | renders the platform service unit (calls `lib/service.mjs`) for the installer |
| `scan.mjs` | scans `$HOME` for projects, writes and merges the registry |
| `lib/state.mjs` | pure: resolves the one state directory and the paths under it |
| `lib/bind.mjs` | pure: the :80 -> numbered-port fallback decision and URL formatting |
| `lib/service.mjs` | pure: platform detection, unit paths, launchd plist + systemd unit renderers |
| `lib/registry.mjs` | pure: the scan merge logic |
| `projects.json` | the registry (gitignored; see `projects.example.json`) |
| `lazydev` | the CLI (bash) |
| `install.sh` | detects the platform and writes the launchd plist (macOS) or systemd user unit (Linux), then loads it |
| `uninstall.sh` | reverses the installer on either platform |
| `serve_static.py` | optional static server with cleanUrls, for static sites |
| `logs/` | runtime: `daemon.log` plus `<host>.log` per project |

The registry, logs, and control token live in one state directory, not next to
the code. `npx lazydev` and the persistent install both resolve it to
`$XDG_STATE_HOME/lazydev` (or `~/.local/state/lazydev`), or to `LAZYDEV_STATE_DIR`
if you set it, so a foreground run and an installed service share one layout.

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

- `port` is the daemon's own port (default 4000, what Caddy forwards to).
- `idleTimeoutMs` is how long a project can sit untouched before the reaper sleeps it.
- `startTimeoutMs` is how long the daemon waits for a cold server to answer before giving up.
- `scanExclude` is an optional list of path substrings `scan` skips.

Per project:

- `host` is the subdomain label. The URL is `http://<host>.localhost`. Must be unique.
- `dir` is the absolute project directory. It may contain spaces, so it is passed as `cwd`, never interpolated into a shell string.
- `port` is the fixed port lazydev runs, health-checks, and proxies this project on.
- `startCmd` is the command run with `cwd=dir`. The daemon injects `PORT=<port>` into the environment. Vite ignores `PORT`, so Vite start commands must pass `--port <port> --strictPort` explicitly.
- `framework` is one of `next | vite | cra | astro | remix | sveltekit | node`, informational.
- `enabled` false keeps the project registered but parked; the daemon returns a disabled page and never starts it.

## host resolution

Given the incoming `Host` header:

1. Strip any `:port` suffix and a trailing `.localhost`.
2. Of the remaining dot-separated labels, the project key is the last one.
   - `webapp.localhost` resolves to `webapp`
   - `tenant.webapp.localhost` also resolves to `webapp`, and the original Host header is preserved upstream so the app's own multi-tenant logic still sees `tenant`
3. Look up an enabled project whose `host` equals that key. A miss returns a friendly page listing the available `*.localhost` URLs.

The daemon does this last-label match itself for both `*.localhost` and
`*.*.localhost` on every request, since it is the front door now.

## `*.localhost` resolution on Linux

`*.localhost` is loopback by web standard (RFC 6761), and browsers resolve it on
their own with no setup: no `/etc/hosts` edits, no custom resolver. That covers
the normal case, since lazydev is a browser tool.

Command-line tools are a different story on Linux. Many glibc distributions
resolve bare `localhost` but not arbitrary `*.localhost` subdomains through the
system resolver, so `curl http://webapp.localhost/` can fail to resolve there
even though the browser is fine. Point curl at loopback explicitly with
`--resolve`:

```bash
curl --resolve webapp.localhost:80:127.0.0.1 http://webapp.localhost/
```

On a fallback port (Linux `npx lazydev` without the :80 capability), use that
port on both sides:

```bash
curl --resolve webapp.localhost:7420:127.0.0.1 http://webapp.localhost:7420/
```

macOS resolves `*.localhost` for CLI tools too, so this only comes up on Linux.

## lifecycle notes

- Dev servers spawn as process-group leaders, so sleeping a project kills the whole tree with one signal (the package manager, the framework under it, its workers). Nothing is left squatting the port.
- Health probes try both loopbacks. On some machines `localhost` resolves only to `::1`, and plenty of dev servers listen on one family only, so the daemon probes `127.0.0.1` and `::1` separately.
- `scan` merges instead of overwriting: it preserves the port, start command, and enabled flag of any host already in the registry, and only assigns fresh ports to newly discovered projects. Hand-added entries whose directory still exists are carried through untouched.
