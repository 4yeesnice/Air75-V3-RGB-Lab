// Render from the current clock after each acknowledged frame. Slow USB writes
// must not build a queue of stale animation/audio frames or halve the frame rate
// by missing the next setInterval tick.
//
// Frames are scheduled against a fixed deadline grid rather than "period after this
// frame started": on Windows setTimeout rounds up to the ~15.6 ms system tick, and
// re-anchoring on the late wake-up turned 30 fps into a steady 21 fps. Overshoot of
// less than one period is absorbed by the next deadline; a frame later than that
// re-anchors on the current time, so there is still never a catch-up burst.
export function startFrameLoop(tick, {
  fps = 30, now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  const period = 1000 / fps;
  let stopped = false, timer, deadline = now() + period;
  const run = async () => {
    const started = now(), late = started - deadline;
    deadline = (late >= 0 && late < period ? deadline : started) + period;
    try { await tick(); }
    finally {
      if (!stopped) timer = schedule(run, Math.max(1, deadline - now()));
    }
  };
  timer = schedule(run, period);
  return { stop() { stopped = true; cancel(timer); } };
}
