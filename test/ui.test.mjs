// Spinner behavior under a live event loop. The regression this locks in: the
// install phase once ran spawnSync/cpSync under the spinner, which starved the
// redraw interval and froze the animation on its first frame. The spinner must
// visibly advance while the awaited work yields, and stay silent on pipes.
// Pure node:test + node:assert, fake stream, no TTY, no timers beyond ~300ms.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeSpinner, makeStyler } from '../lib/ui.mjs';

function fakeStream() {
  const chunks = [];
  return { chunks, write: (s) => chunks.push(String(s)) };
}

const FRAME_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;

test('spinner advances through distinct frames while awaited work yields', async () => {
  const stream = fakeStream();
  const styler = makeStyler({ isTTY: false }); // plain text, frames still written
  const spin = makeSpinner({ isTTY: true, styler, minMs: 0, intervalMs: 20, stream });
  spin.start('installing the LaunchAgent');
  await new Promise((r) => setTimeout(r, 200));
  await spin.done('done');
  const frames = stream.chunks.join('').match(FRAME_RE) || [];
  assert.ok(new Set(frames).size >= 3, `expected several distinct frames, saw: ${[...new Set(frames)].join(' ')}`);
});

test('spinner stays frame-free when not a TTY', async () => {
  const stream = fakeStream();
  const styler = makeStyler({ isTTY: false });
  const spin = makeSpinner({ isTTY: false, styler, minMs: 0, intervalMs: 20, stream });
  spin.start('scanning');
  await new Promise((r) => setTimeout(r, 60));
  await spin.done('final line');
  const outText = stream.chunks.join('');
  assert.equal(outText.match(FRAME_RE), null, 'no braille frames on a pipe');
  assert.ok(outText.includes('final line'), 'only the final line prints');
  assert.ok(!outText.includes('\r'), 'no carriage returns on a pipe');
});

test('done() waits out minMs so a fast phase still shows its work', async () => {
  const stream = fakeStream();
  const styler = makeStyler({ isTTY: false });
  const spin = makeSpinner({ isTTY: true, styler, minMs: 120, intervalMs: 20, stream });
  const before = Date.now();
  spin.start('quick phase');
  await spin.done('held');
  assert.ok(Date.now() - before >= 110, 'done() holds until minMs has passed');
});
