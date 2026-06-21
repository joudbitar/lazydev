# lazydev

**On-demand local dev-server proxy.** Every project you work on is reachable at a
stable URL — `http://<host>.localhost` — whether or not its dev server is
currently running. The first request to a URL *wakes* that project's dev server;
after **30 minutes of inactivity** lazydev *sleeps* it again to free RAM, CPU, and
its port. Think "Vercel preview URLs, but local, with sleep/wake."

You stop juggling `pnpm dev` in fifteen terminal tabs and remembering which one is
on which port. You just visit `http://tradepulse.localhost` and it's there.

---

## How it works (architecture)

```
browser  ->  http://<host>.localhost          e.g. http://tradepulse.localhost
         ->  Caddy on :80                      wildcard *.localhost  ->  localhost:4000
         ->  lazydev daemon on :4000
               1. read the Host header  ->  figure out which project
               2. if that project's dev server is asleep, start it (and wait)
               3. reverse-proxy the request (HTTP + WebSocket/HMR) to its port
               4. record "last accessed"; a background reaper sleeps idle projects
         ->  the project's own dev server on its fixed port   e.g. :3000
```

Three layers:

- **Caddy (:80)** owns the wildcard `*.localhost` and forwards everything to the
  daemon. It's the only thing bound to port 80.
- **lazydev daemon (:4000)** is the brain: it maps hostnames to projects, starts/stops
  dev servers on demand, proxies traffic, and reaps idle projects.
- **Your dev servers** (Next, Vite, etc.) each run on their own fixed port. lazydev
  starts and stops them for you — you never run `pnpm dev` by hand again.

Nothing here needs `sudo`, and the daemon has **zero npm dependencies** (Node
built-ins only).

---

## Install / uninstall

The proxy is installed as a macOS **LaunchAgent** (`com.lazydev.proxy`) plus a Caddy
config block, by the bundled scripts:

```bash
~/lazydev/install.sh      # writes the launchd plist + Caddyfile, loads both
~/lazydev/uninstall.sh    # tears them back down
```

The `lazydev` CLI is symlinked onto your PATH at `~/.local/bin/lazydev`.

---

## CLI commands

Run `lazydev help` any time. All commands:

### `lazydev` &nbsp;/&nbsp; `lazydev ls`
The status table. Shows the daemon's uptime and idle-timeout up top, then one row
per project: host, its `http://<host>.localhost` URL, state, how long it's been idle,
and its port.

```
lazydev  daemon up 2h  ·  sleeps idle projects after 30m

HOST           URL                             STATE     IDLE  PORT
tradepulse     http://tradepulse.localhost     running   4m    3000
traypal        http://traypal.localhost        starting  —     3110
sahtein-menus  http://sahtein-menus.localhost  sleeping  —     3100
```

State is colored: **running** = green, **starting** = yellow, **sleeping** (stopped)
and disabled projects = dim. If the daemon isn't reachable on :4000, it says so and
suggests `lazydev restart`.

### `lazydev open <host>`
Wake the project (if asleep) and open `http://<host>.localhost` in your browser.

```bash
lazydev open tradepulse
```

### `lazydev sleep <host>`
Put a project to sleep right now (don't wait for the 30-minute idle timer). Frees its
port immediately.

```bash
lazydev sleep traypal
```

### `lazydev logs <host> [-f]`
Tail that project's dev-server log. Add `-f` to follow live (like `tail -f`).

```bash
lazydev logs tradepulse        # last 200 lines
lazydev logs tradepulse -f     # follow
```

If the project hasn't started yet there's no log; the CLI tells you to `lazydev open`
it first.

### `lazydev daemon-logs [-f]`
Tail the daemon's own log (lifecycle events, proxy errors, reaper activity). `-f` to
follow.

```bash
lazydev daemon-logs -f
```

### `lazydev scan`
Rescan your home directory for projects, merge them into the registry, tell the daemon
to reload, then print the table. **This is how you add a project** (see below).

```bash
lazydev scan
```

### `lazydev restart`
Restart the daemon (via `launchctl kickstart`, falling back to unload/load of the
plist), wait for :4000 to come back, then print the table. Use this after editing
`projects.json` by hand, or if the daemon seems wedged.

```bash
lazydev restart
```

### `lazydev status`
One-line health check: is the daemon listening on :4000, and is Caddy listening on
:80? Prints `OK` / `DOWN` for each.

```bash
lazydev status
# daemon (:4000)  OK
# caddy  (:80)  OK
```

### `lazydev dash`
Open the daemon's built-in HTML dashboard at `http://lazydev.localhost`.

### `lazydev help` &nbsp;/&nbsp; `-h` &nbsp;/&nbsp; `--help`
Show usage.

---

## Where things live

| Path | What |
|------|------|
| `~/lazydev/projects.json` | The registry — every project lazydev knows about |
| `~/lazydev/logs/<host>.log` | Per-project dev-server output |
| `~/lazydev/logs/daemon.log` | The daemon's own log |
| `~/lazydev/lazydev` | This CLI (symlinked to `~/.local/bin/lazydev`) |
| `~/lazydev/lazydev.mjs` | The daemon (run by launchd) |
| `~/lazydev/scan.mjs` | The project scanner |
| `~/Library/LaunchAgents/com.lazydev.proxy.plist` | The LaunchAgent that runs the daemon |

---

## Adding a project

The easy way — drop a project anywhere under your home directory, then:

```bash
lazydev scan
```

`scan` finds web projects (a `package.json` with a `dev` script), merges any new ones
into `projects.json` without clobbering your existing entries, reloads the daemon, and
prints the updated table. Your new project is now live at `http://<host>.localhost`.

If you need to tweak how a project starts — its port, its start command, or its
framework — edit its entry in `projects.json` directly. The registry shape:

```json
{
  "port": 4000,
  "idleTimeoutMs": 1800000,
  "startTimeoutMs": 120000,
  "projects": [
    {
      "host": "tradepulse",
      "dir": "/Users/joudbitar/tradepulse",
      "port": 3000,
      "startCmd": "pnpm dev",
      "framework": "next",
      "enabled": true
    }
  ]
}
```

- **`host`** — the subdomain label; the URL is `http://<host>.localhost`. Must be unique.
- **`dir`** — absolute project directory.
- **`port`** — the fixed port lazydev runs and proxies this project on.
- **`startCmd`** — run with the project dir as the working directory; lazydev injects
  `PORT=<port>`. Vite ignores `PORT`, so Vite projects must pass
  `--port <port> --strictPort` in the command explicitly.
- **`framework`** — `next | vite | cra | astro | remix | sveltekit | node` (informational).
- **`enabled`** — set to `false` to keep a project registered but parked; the daemon
  serves a "disabled" page instead of starting it.

After editing `projects.json` by hand, run `lazydev restart` (or `lazydev scan`, which
also reloads) to apply it.

---

## Prod-style subdomain routing

Real apps often serve different tenants on different subdomains
(`acme.yourapp.com`, `globex.yourapp.com`). lazydev mirrors that locally so your
multi-tenant code path actually runs.

When resolving a hostname, lazydev takes the **last** label before `.localhost` as the
project key:

| You visit | Routes to project | App's `Host` header sees |
|-----------|-------------------|--------------------------|
| `traypal.localhost` | `traypal` | `traypal.localhost` |
| `trinity.traypal.localhost` | `traypal` | `trinity.traypal.localhost` |

So `trinity.traypal.localhost` is handled by the **traypal** project, but the
**original Host header is preserved** when proxied upstream — your app's own
multi-tenant logic still sees `trinity` and can serve that tenant. One dev server,
many tenant subdomains, no extra config.

---

## Changing the idle timeout

Projects sleep after 30 minutes of inactivity by default. To change it, edit
`idleTimeoutMs` (milliseconds) at the top of `projects.json`, then restart:

```jsonc
// ~/lazydev/projects.json
{
  "idleTimeoutMs": 3600000,   // 1 hour
  ...
}
```

```bash
lazydev restart
```

Set it large if you want projects to stay warm longer; set it small to reclaim
resources aggressively.

---

## Troubleshooting

- **`lazydev ls` says the daemon is unreachable** — run `lazydev restart`, then
  `lazydev status`. If it still won't come up, check `lazydev daemon-logs`.
- **A project won't load** — `lazydev logs <host> -f` shows its dev-server output;
  most failures (a missing dependency, a port conflict, a build error) show up there.
- **`lazydev status` shows Caddy DOWN** — Caddy isn't bound to :80; re-run
  `~/lazydev/install.sh` or restart it via `brew services restart caddy`.
