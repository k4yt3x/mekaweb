import { expect, it } from 'vitest';
import type { Schema } from '../api/client';
import { contextMetrics } from './usage';

const context: Schema['ContextResponse'] = {
  session_id: 'usage-test',
  generation: 0,
  used: 15000,
  window: 20000,
  totals: {
    turns: 2,
    input_tokens: 100,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 1700,
    output_tokens: 300,
  },
};

it('includes cache writes and reads in input totals and weights hits by tokens, not turns', () => {
  expect(contextMetrics(context)).toEqual({
    totalInputTokens: 2000,
    cacheHitPercent: 85,
    remainingTokens: 5000,
  });
});

it.each<[number, number, number, number | null]>([
  [0, 0, 0, null],
  [100, 0, 0, 0],
  [0, 100, 0, 0],
  [0, 0, 100, 100],
])('distinguishes unreported usage from zero hits (%s, %s, %s)', (input, writes, reads, rate) => {
  expect(
    contextMetrics({
      ...context,
      totals: {
        ...context.totals,
        input_tokens: input,
        cache_creation_input_tokens: writes,
        cache_read_input_tokens: reads,
      },
    }).cacheHitPercent,
  ).toBe(rate);
});

it('does not invent context capacity when occupancy or the window is unavailable', () => {
  expect(contextMetrics({ ...context, used: null }).remainingTokens).toBeNull();
  expect(contextMetrics({ ...context, window: null }).remainingTokens).toBeNull();
  expect(contextMetrics({ ...context, window: 0 }).remainingTokens).toBeNull();
  expect(contextMetrics({ ...context, used: 21000 }).remainingTokens).toBe(0);
});
