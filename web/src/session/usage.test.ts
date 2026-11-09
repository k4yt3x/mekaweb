import { expect, it } from 'vitest';
import type { Schema } from '../api/client';
import { contextMetrics, contextNear, usageMetrics } from './usage';

const context: Schema['ContextResponse'] = {
  session_id: 'usage-test',
  position: 12,
  generation: 0,
  used: 15000,
  window: 20000,
};
const usage: Schema['TurnUsage'] = {
  input_tokens: 100,
  cache_creation_input_tokens: 200,
  cache_read_input_tokens: 1700,
  output_tokens: 300,
};

it('measures the context window', () => {
  expect(contextMetrics(context)).toEqual({ usedPercent: 75, remainingTokens: 5000 });
});

it('includes cache writes and reads in input totals and weights hits by tokens, not turns', () => {
  expect(usageMetrics(usage)).toEqual({ totalInputTokens: 2000, cacheHitPercent: 85 });
});

it.each<[number, number, number, number | null]>([
  [0, 0, 0, null],
  [100, 0, 0, 0],
  [0, 100, 0, 0],
  [0, 0, 100, 100],
])('distinguishes unreported usage from zero hits (%s, %s, %s)', (input, writes, reads, rate) => {
  expect(
    usageMetrics({
      ...usage,
      input_tokens: input,
      cache_creation_input_tokens: writes,
      cache_read_input_tokens: reads,
    }).cacheHitPercent,
  ).toBe(rate);
});

it('does not invent context capacity when occupancy or the window is unavailable', () => {
  for (const missing of [{ used: null }, { window: null }, { window: 0 }]) {
    const metrics = contextMetrics({ ...context, ...missing });
    expect(metrics.remainingTokens).toBeNull();
    expect(metrics.usedPercent).toBeNull();
  }
  expect(contextMetrics({ ...context, used: 21000 }).remainingTokens).toBe(0);
});

it('rounds occupancy down, as Meka did', () => {
  expect(contextMetrics({ ...context, used: 19999 }).usedPercent).toBe(99);
  expect(contextMetrics({ ...context, used: 21000 }).usedPercent).toBe(105);
});

it('counts context as near ten points before Meka compacts it, or at 80% when it does not', () => {
  expect(contextNear(69, 80)).toBe(false);
  expect(contextNear(70, 80)).toBe(true);
  expect(contextNear(79, null)).toBe(false);
  expect(contextNear(80, undefined)).toBe(true);
  expect(contextNear(100, 95)).toBe(true);
});
