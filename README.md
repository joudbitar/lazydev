# lazydev

A local proxy that starts dev servers on demand behind permanent URLs.

Every project on your machine gets a stable address, `http://<name>.localhost`, whether or not its dev server is running. The first request wakes the server; thirty idle minutes put it back to sleep. You stop running `pnpm dev` in fifteen tabs, stop guessing which port is which, and stop feeding RAM to a server you opened on Tuesday.

```
$ npx lazydev
lazydev: scanning for projects...

  HOST    PORT  FRAMEWORK  STARTCMD     DIR
  api     3010  next       pnpm dev     ~/code/api
  blog    3020  astro      npm run dev  ~/code/blog
  webapp  3030  vite       pnpm dev     ~/code/webapp

lazydev is serving the front door on :4000 (:80 was unavailable, using :4000).

your projects:
  http://api.localhost:4000
  http://blog.localhost:4000
  http://webapp.localhost:4000

dashboard: http://lazydev.localhost:4000
```

<!-- gif: record `npx lazydev` in a terminal, then visit a sleeping project in the browser. the tab spins a few seconds while the server boots, then the app appears. ~10s with QuickTime or Kap, crop to terminal + browser. -->

## How it works

`*.localhost` resolves to your own machine by web standard, so there is nothing to configure: no /etc/hosts edits, no DNS tools, no browser proxy. lazydev listens there, reads the host name, and looks the project up in its registry, one JSON file of name, folder, port, start command.

If the project's server is running, the request is proxied straight through. If it's asleep, you get an instant status page while lazydev runs the start command, then it hands you to the app the moment the port answers; a Next app cold-starts in about 8 seconds on my machine, timed with curl. After 30 minutes without traffic the server is killed and its RAM freed. The URL never changes; only the process comes and goes.

Hot-module reload works through the proxy, and `tenant.myapp.localhost` routes to `myapp` with the Host header intact, so multi-tenant apps still see their subdomain.

`npx lazydev` scans your home directory for projects with a `dev` script, assigns each a free port, and serves in the foreground until Ctrl-C. All state lives in `~/.local/state/lazydev`; nothing touches your project folders, and deleting that one directory removes every trace. Anything the scan can't see (a static folder, a Python server) is one JSON entry in the registry.

## The persistent install

The npx run serves on :4000, so URLs carry the port. Installing gets you the portless URLs and survives reboots. macOS, Node 20+, and Caddy (`brew install caddy`):

```bash
git clone https://github.com/joudbitar/lazydev ~/lazydev
~/lazydev/install.sh
lazydev scan
```

This loads a LaunchAgent that keeps the daemon alive, puts Caddy on :80 as the front door, and links a CLI onto your PATH. No sudo anywhere; `uninstall.sh` puts everything back.

```
lazydev              status table: every project, URL, state, idle time, port
lazydev open <x>     wake <x> and open it in the browser
lazydev sleep <x>    stop <x> now instead of waiting for the idle timer
lazydev logs <x> -f  tail <x>'s dev-server output
lazydev scan         find new projects and register them
lazydev dash         the status table as a web page, at http://lazydev.localhost
lazydev restart      bounce the daemon
```

## How it's built

The daemon is one Node file with zero npm dependencies: router, reverse proxy, process supervisor, and idle reaper in about 2,000 lines of built-ins.

- Everything is loopback-only and fails closed: requests from off the machine get a 403, and the control plane requires a token the daemon mints at boot. Who serves :80 differs per platform; the reasoning is in [docs/adr/0001-npx-front-door.md](docs/adr/0001-npx-front-door.md).
- Dev servers spawn as process-group leaders, so sleeping a project kills the whole tree with one signal: pnpm, the framework under it, its workers.
- Health probes try `127.0.0.1` and `::1` separately, because plenty of dev servers listen on one family only.
- `scan` merges instead of overwriting, so a rescan never clobbers the port or start command you fixed by hand.

## What it doesn't do

- Portless URLs from npx alone; a listener on :80 means the Caddy install on macOS or CAP_NET_BIND_SERVICE on Linux. `npx lazydev` runs fine on Linux, but the installer is macOS launchd; a systemd port is the PR I'd merge first.
- https, yet. The installed path is a Caddy config line away.
- Anything except dev servers. Databases, Docker, queues, and tunnels are out of scope, and stopping idle servers is the opposite of what a production process manager wants.

## Alternatives

[hotel](https://github.com/typicode/hotel) proved people want this (10k stars) and then went quiet; it starts servers on access but never stops them. [chalet](https://github.com/jeansaad/chalet) is its maintained fork, same model. [puma-dev](https://github.com/puma/puma-dev) has real wake and sleep but is built around Rails and installs its own DNS resolver. [rpx](https://github.com/stacksjs/rpx) is the closest living tool, part of the Stacks ecosystem. Use lazydev if you want a permanent URL for every project, your RAM back, and a codebase you can read in one sitting.

## License

MIT
