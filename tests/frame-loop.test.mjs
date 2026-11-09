import test from 'node:test';
import assert from 'node:assert/strict';
import {startFrameLoop} from '../server/frame-loop.mjs';

test('USB frame acknowledgements pace rendering without overlapping or catch-up bursts', async () => {
  let now = 0, next, finish, calls = 0;
  const scheduled = [];
  const loop = startFrameLoop(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, {
    now: () => now,
    schedule: (fn, ms) => { next = fn; scheduled.push(ms); return 1; }, cancel: () => {},
  });
  assert.ok(Math.abs(scheduled[0] - 1000/30) < .01);
  const first = next();
  assert.equal(calls, 1); assert.equal(scheduled.length, 1, 'no queued render before USB ACK');
  now = 20; finish(); await first;
  assert.ok(Math.abs(scheduled[1] - (1000/30 - 20)) < .01, 'USB time is included in frame period');
  const second = next(); now = 120; finish(); await second;
  assert.equal(scheduled[2], 1, 'late frame yields and renders current time without replaying old frames');
  const third = next(); loop.stop(); finish(); await third;
  assert.equal(scheduled.length, 3, 'shutdown during a frame prevents any further render');
});

test('coarse Windows timers (15.6 ms tick) still deliver 30 fps on average', async () => {
  let t = 0; const queue = [], frames = [], tick = 15.625;
  const loop = startFrameLoop(async () => { frames.push(t); t += 3; }, {
    now: () => t, cancel: () => {},
    schedule: (fn, ms) => { queue.push({ at: Math.ceil((t + ms) / tick) * tick, fn }); return queue.length; },
  });
  while (frames.length < 120) { queue.sort((a, b) => a.at - b.at); const e = queue.shift(); t = Math.max(t, e.at); await e.fn(); }
  loop.stop();
  const fps = (frames.length - 1) / ((frames.at(-1) - frames[0]) / 1000);
  assert.ok(fps > 29.5 && fps < 30.5, `expected ~30 fps, got ${fps.toFixed(1)}`);
  assert.ok(frames.every((v, i) => i === 0 || v - frames[i - 1] >= tick), 'no back-to-back catch-up frames');
});
