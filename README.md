# lazydev

A local proxy that starts dev servers on demand behind permanent URLs.

You have ten projects. Each has a dev server that grabs a port and eats RAM whether or not you're using it, so you either keep fifteen terminal tabs alive or keep restarting things and guessing which port is which. lazydev's deal: every project gets a permanent URL, `http://portfolio.localhost`, and the server behind it runs only while you're actually using it.

There is one way to get it, and it asks before it does anything:

```
$ npx @jbitar/lazydev

  lazydev v0.1.0

  this will:

  1. walk your home folder for projects it can prove how to run: node with
     a "dev" script, rails apps, django with a venv or lockfile, static
     folders with their own git repo. it reads marker files (package.json,
     manage.py) and nothing inside your projects is written or changed.
  2. give each project a permanent URL like http://myapp.localhost,
     reachable only from this machine. connections from the network are
     refused, and nothing you have leaves your computer.
  3. install a background service (a user LaunchAgent, no sudo) so the
     URLs keep working after reboots and closed terminals.
  4. add the add-project skill to ~/.claude/skills, so your coding
     agent can register anything the scanner cannot prove (Flask, Go,
     docker-compose) as one registry entry.

  everything it creates lives in ~/.local/state/lazydev, plus one plist in
  ~/Library/LaunchAgents and one symlink in ~/.local/bin.
  `lazydev uninstall` removes every trace.

  proceed? [Y/n] y

  lazydev v0.1.0  installed in 1214 ms

  dashboard  http://lazydev.localhost
  projects   http://<name>.localhost for each of 3 projects, e.g. http://portfolio.localhost

  runs in the background and survives reboots · registry: ~/.local/state/lazydev/projects.json · logs: ~/.local/state/lazydev/logs
  `lazydev` rescans for new projects · `lazydev uninstall` removes everything
  agent skill: add-project installed to ~/.claude/skills · other agents: npx skills add joudbitar/lazydev
```

That's the whole install. Answering `n` exits with nothing read and nothing written.

<!-- gif: record `npx @jbitar/lazydev` in a terminal (consent prompt, y, installed banner), then visit a sleeping project in the browser. the tab spins a few seconds while the server boots, then the app appears. ~12s with QuickTime or Kap, crop to terminal + browser. -->

The dashboard at `http://lazydev.localhost`:

![the lazydev dashboard: five projects, two awake, sleep buttons for the running ones](docs/dashboard.png)

## How it works

You open `http://portfolio.localhost`. Addresses ending in `.localhost` reach your own machine by web standard, no /etc/hosts edits, no DNS tools, so the request lands on lazydev, which reads the host name and looks `portfolio` up in its registry: one JSON file of name, folder, port, start command.

If portfolio's server is running, the request is piped straight through and you never notice lazydev was there. If it's asleep, you get an instant page with a spinner while lazydev runs the project's start command; the moment the port answers you're handed to the real app, no manual reload. A Next app cold-starts in about 8 seconds on my machine, timed with curl. Thirty minutes after the last request, the server is killed and its RAM freed. The URL keeps working; the next visit wakes it again.

Sleeping a project kills the whole process tree (pnpm, the framework under it, its workers), not just the top pid. WebSockets are piped raw, so hot-module reload works through the proxy. `tenant.myapp.localhost` routes to `myapp` with the Host header intact, so multi-tenant apps still see their subdomain. And a dev server you started yourself in a terminal gets adopted, not fought.

`npx @jbitar/lazydev` scans your home directory (or the `scanRoots` you set in the registry) for projects it can prove how to run: Node projects with a `dev` script, Rails apps, Django projects with a visible venv or lockfile, and static folders that are their own git repo. Static finds register parked until you switch them on, since build output and docs folders look the same on disk. Each project gets a free port, and a user LaunchAgent keeps the daemon alive through reboots; the daemon itself owns :80, loopback-only, so there is no Caddy and no sudo anywhere. All state lives in `~/.local/state/lazydev`; nothing touches your project folders. Anything the scan can't prove (a Flask app, a Go server, docker-compose) is one JSON entry in the registry, and the install puts an agent skill ([add-project](.claude/skills/add-project/SKILL.md)) into `~/.claude/skills` that teaches a coding agent to write that entry end to end: read the project, pick the start command and port, register it, and poll the URL until it wakes. Tell your agent "add my flask app to lazydev" and it does the rest. On Cursor, Codex, or another agent, `npx skills add joudbitar/lazydev` installs the same skill where your agent looks for it. The scanner covers the provable case; your agent covers yours.

## Day to day

The dashboard at `http://lazydev.localhost` is the control surface: every project, its state, and a sleep button for the running ones. The terminal side is deliberately small:

```
lazydev              rescan for new projects and refresh the install
lazydev uninstall    stop the service and remove every trace
```

Logs are plain files: `~/.local/state/lazydev/logs/daemon.log` for the proxy, `<host>.log` per project. The registry at `~/.local/state/lazydev/projects.json` is yours to edit: rename a project, change its port, park it, or add `scanRoots` and `scanExclude` to steer the scanner. A rescan merges; it never clobbers what you fixed by hand.

## How it's built

The daemon is one Node file with zero npm dependencies: router, reverse proxy, process supervisor, and idle reaper in about 2,000 lines of built-ins.

- Everything is loopback-only and fails closed: a connection from off the machine is dropped at accept, and a request that somehow gets further is refused with a 403. The control plane requires a token the daemon mints at boot. How :80 gets bound per platform is in [docs/adr/0002-wildcard-bind-loopback-guard.md](docs/adr/0002-wildcard-bind-loopback-guard.md).
- Health probes try `127.0.0.1` and `::1` separately, because plenty of dev servers listen on one family only.
- `scan` merges instead of overwriting, so a rescan never clobbers the port or start command you fixed by hand.

## What it doesn't do

- A background service on Linux. The same command works there, but it serves in the foreground until Ctrl-C, and without CAP_NET_BIND_SERVICE the URLs carry :4000. A systemd unit is the PR I'd merge first.
- https, yet.
- Anything except dev servers. Databases, Docker, queues, and tunnels are out of scope, and stopping idle servers is the opposite of what a production process manager wants.

## Alternatives

[hotel](https://github.com/typicode/hotel) proved people want this (10k stars) and then went quiet; it starts servers on access but never stops them. [chalet](https://github.com/jeansaad/chalet) is its maintained fork, same model. [puma-dev](https://github.com/puma/puma-dev) has real wake and sleep but is built around Rails and installs its own DNS resolver. [rpx](https://github.com/stacksjs/rpx) is the closest living tool, part of the Stacks ecosystem. Use lazydev if you want a permanent URL for every project, your RAM back, and a codebase you can read in one sitting.

## License

MIT
