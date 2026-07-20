# 1. The daemon serves the front door directly, no Caddy

Status: accepted

## Context

Trying lazydev today is a three-step chore. You clone the repo, install Caddy
(`brew install caddy`), and run a bash script that writes a launchd plist and
edits your system Caddyfile. Caddy owns port 80 and forwards every
`*.localhost` request to the daemon on 4000. That is a lot of moving parts and a
second binary to install before anyone sees a single project wake up.

The goal is `npx lazydev` on a machine that has nothing but Node. One command,
no clone, no Caddy, no editing system files.

The daemon already has everything the front door needs. It parses the Host
header to pick a project, reverse-proxies HTTP, pipes WebSocket and HMR
connections raw, and routes subdomains to their parent project. Caddy in front
of it is doing almost nothing that the daemon cannot do itself: it terminates
:80 and forwards. So the daemon can be the front door.

## Decision

The daemon serves the front door directly on port 80. There is no bundled or
installed second proxy. No Caddy, for either path: the `npx lazydev` path and
the persistent background install both run the same daemon listening on the
front-door port itself.

One named state directory holds the registry, the logs, and the control-plane
token, so the npx run and the persistent install share the same layout.

The loopback binding from ADR-era issue #2 stays exactly as it is. Even on :80
the daemon binds only the loopback families (127.0.0.1 and ::1) and keeps the
fail-closed guard that 403s any local socket that is not loopback. Moving to
port 80 changes the port, not the exposure.

### Port 80 across platforms

Binding :80 is not uniform, so each case is handled on its own:

- macOS grants an unprivileged process the :80 bind. The daemon binds it
  directly, npx or installed.
- Linux does not, without `CAP_NET_BIND_SERVICE`. A plain `npx lazydev` on
  Linux has no such capability.

The npx path handles this by trying :80 first and falling back on failure. On
`EACCES` or `EADDRINUSE` it binds a numbered port instead and prints every URL
with the port included, for example `http://webapp.localhost:7420`, so the
printed URLs are the ones that actually work. No error, no manual step; the
fallback is the normal Linux experience.

The persistent installs each grant :80 the way their init system allows:

- Persistent Linux is a systemd user unit with
  `AmbientCapabilities=CAP_NET_BIND_SERVICE`, so the installed daemon binds :80.
  If the capability cannot be granted, the service falls back to the same
  numbered port and prints the port, matching the npx behaviour.
- Persistent macOS stays a launchd plist. The daemon binds :80 directly, since
  macOS allows it.

## Consequences

Dropping Caddy costs real things, and they are worth naming:

- We lose Caddy's TLS. HTTPS on `*.localhost` was a config line in the
  Caddyfile; now it would be a TLS implementation in Node, which we are not
  writing. lazydev stays HTTP for local dev.
- We lose Caddy's other jobs: serving multiple sites, its own static file
  handling, and the fact that it is a battle-tested edge that has run in front
  of production traffic for years. The daemon's proxy is younger and narrower.
- We lose the restart resilience of a separate front door. Caddy held :80 open
  while the daemon restarted on registry reloads and upgrades. Now a daemon
  restart briefly drops the front door with it.

In exchange:

- A true zero-dependency install. `npx lazydev` needs only Node. No clone, no
  brew, no system-file edits.
- One front-door model everywhere. The same daemon binds the same port whether
  you ran it through npx or installed it, on macOS or Linux, so there is one
  code path to reason about and test.

Publishing lazydev to npm as a real `npx lazydev` is a separate maintainer step
and is not part of this decision. This ADR plus the `bin` entry in
`package.json` make the code path exist and run locally: you can point npx at a
local checkout, or run the bin directly, and get the front-door-on-:80 behaviour
today. The npm publish is what makes the bare `npx lazydev` command resolve for
everyone else.

## Upgrading from npx to the persistent daemon

The npx run is foreground and dies with the terminal. Turning it into the
persistent background daemon is one command: `npx lazydev install` (equivalently
the linked CLI's `lazydev install`). That writes the platform's service unit
(launchd on macOS, a systemd user unit on Linux), grants :80 where the platform
needs a capability for it, and starts the daemon so it survives logout and
reboot. Same daemon, same state directory, same front door. The only thing that
changes is that it now runs in the background and comes back on its own.
