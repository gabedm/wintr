import type { Frames } from '../../src/client/motion.js';

/** Deterministic frame clock: nothing runs until a test advances it. */
export class FakeFrames implements Frames {
  t = 0;
  private next = 0;
  readonly queue = new Map<number, () => void>();
  now() {
    return this.t;
  }
  raf(cb: () => void) {
    this.queue.set(++this.next, cb);
    return this.next;
  }
  caf(id: number) {
    this.queue.delete(id);
  }
  /** Advance the clock and run the frames that were scheduled before this step. */
  step(ms: number) {
    this.t += ms;
    const run = [...this.queue.values()];
    this.queue.clear();
    run.forEach((cb) => cb());
  }
  /** Run frames in 16 ms steps for `ms` total. */
  run(ms: number) {
    for (let spent = 0; spent < ms; spent += 16) this.step(Math.min(16, ms - spent));
  }
}
