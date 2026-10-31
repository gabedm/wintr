import { expect, it } from 'vitest';
import { createMetadataBudget } from '../src/server/net/safe-fetch.js';

it('reserves a released slot for the queued waiter before a new caller can enter', async () => {
  const budget = createMetadataBudget(10, 1);
  let release!: () => void;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held = new Promise<void>((resolve) => { finish = resolve; });
  let active = 0;
  let peak = 0;
  const first = budget.slot(() => gate);
  const task = () => budget.slot(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await held;
    active -= 1;
  });
  const second = task();
  release();
  let third!: Promise<void>;
  // Runs after release processing but before the queued waiter's continuation.
  await new Promise<void>((resolve) => queueMicrotask(() => { third = task(); resolve(); }));
  await Promise.resolve();
  finish();
  await Promise.all([first, second, third]);
  expect(peak).toBe(1);
});
