#!/usr/bin/env node
// render-unit.mjs — render a platform service unit to stdout for install.sh.
//
// The installer decides the platform and gathers the paths in bash, then calls
// this to produce the exact file bytes (launchd plist on macOS, systemd user
// unit on Linux). Keeping the render here means the ONE renderer in
// lib/service.mjs is what both the installer and the node --test suite use, so a
// test can lock the file format the installer actually writes.
//
// Usage:
//   node bin/render-unit.mjs launchd  <nodeBin> <daemon> <workingDir> <stateDir> <logsDir> <home> <pathEnv>
//   node bin/render-unit.mjs systemd  <nodeBin> <daemon> <workingDir> <stateDir> <pathEnv>
//   node bin/render-unit.mjs path     <platform> <home> <xdgConfigHome>   -> prints unitPath
//   node bin/render-unit.mjs label    <platform> <home> <xdgConfigHome>   -> prints label
//   node bin/render-unit.mjs detect   <uname>                             -> prints platform
//
// Prints to stdout; exits non-zero on a usage error. Zero npm dependencies.

import {
  detectPlatform,
  servicePaths,
  renderLaunchdPlist,
  renderSystemdUnit,
} from '../lib/service.mjs';

const [, , kind, ...rest] = process.argv;

function die(msg) {
  process.stderr.write(`render-unit: ${msg}\n`);
  process.exit(2);
}

switch (kind) {
  case 'launchd': {
    const [nodeBin, daemon, workingDir, stateDir, logsDir, home, pathEnv] = rest;
    if (!nodeBin || !daemon || !workingDir || !stateDir || !logsDir || !home || !pathEnv) {
      die('launchd needs: nodeBin daemon workingDir stateDir logsDir home pathEnv');
    }
    process.stdout.write(renderLaunchdPlist({ nodeBin, daemon, workingDir, stateDir, logsDir, home, pathEnv }));
    break;
  }
  case 'systemd': {
    const [nodeBin, daemon, workingDir, stateDir, pathEnv] = rest;
    if (!nodeBin || !daemon || !workingDir || !stateDir || !pathEnv) {
      die('systemd needs: nodeBin daemon workingDir stateDir pathEnv');
    }
    process.stdout.write(renderSystemdUnit({ nodeBin, daemon, workingDir, stateDir, pathEnv }));
    break;
  }
  case 'path':
  case 'label': {
    const [platform, home = '', xdgConfigHome = ''] = rest;
    if (!platform) die(`${kind} needs: platform [home] [xdgConfigHome]`);
    const paths = servicePaths({ platform, home, xdgConfigHome });
    process.stdout.write((kind === 'path' ? paths.unitPath : paths.label) + '\n');
    break;
  }
  case 'detect': {
    process.stdout.write(detectPlatform(rest[0]) + '\n');
    break;
  }
  default:
    die(`unknown kind '${kind}' (want: launchd | systemd | path | label | detect)`);
}
