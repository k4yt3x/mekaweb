import { expect, it } from 'vitest';
import type { Schema } from '../api/client';
import { formatElapsed, formatTokens, turnDetails, turnSummary } from './turn-summary';

const now = new Date(2026, 9, 23, 18, 0);

function turn(overrides: Partial<Schema['TurnRecord']> = {}): Schema['TurnRecord'] {
  return {
    id: 'turn-1',
    source: 'client',
    started_at: new Date(2026, 9, 23, 10, 26, 41).toISOString(),
    ended_at: new Date(2026, 9, 23, 10, 36, 17).toISOString(),
    status: 'succeeded',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 2_000,
      cache_creation_input_tokens: 48_000,
      cache_read_input_tokens: 950_000,
      output_tokens: 23_400,
    },
    ...overrides,
  };
}

const clock = (date: Date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

it('states durations as meka’s terminal does', () => {
  expect(formatElapsed(0)).toBe('0s');
  expect(formatElapsed(59_999)).toBe('59s');
  expect(formatElapsed(576_000)).toBe('9m 36s');
  expect(formatElapsed(3_600_000 + 25 * 60_000 + 9_000)).toBe('1h 25m');
  expect(formatElapsed(2 * 86_400_000 + 3 * 3_600_000)).toBe('2d 3h');
});

it('states token counts as meka’s terminal does', () => {
  expect(formatTokens(999)).toBe('999');
  expect(formatTokens(1_000)).toBe('1.0k');
  expect(formatTokens(234_000)).toBe('234.0k');
  expect(formatTokens(2_300_000)).toBe('2.3M');
});

it('says how and when a turn ended, and after how long', () => {
  const ended = new Date(2026, 9, 23, 10, 36, 17);
  expect(turnSummary(turn(), now)).toBe(`Finished at ${clock(ended)} after 9m 36s`);
  expect(turnSummary(turn({ status: 'failed' }), now)).toMatch(/^Failed at /);
  expect(turnSummary(turn({ status: 'canceled' }), now)).toMatch(/^Interrupted at /);
  expect(turnSummary(turn(), new Date(2026, 9, 24, 9, 0))).toMatch(/^Finished on .+ at .+ after/);
});

it('says nothing of a turn that has not ended', () => {
  expect(turnSummary(turn({ ended_at: null, status: null }), now)).toBeUndefined();
});

it('details what a turn spent, and what was unusual about it', () => {
  const rows = Object.fromEntries(turnDetails(turn(), now).map((row) => [row.label, row.value]));
  expect(rows).toMatchObject({
    Duration: '9m 36s',
    'Tokens in': '1.0M',
    'Tokens out': '23.4k',
    Cached: '95% (950.0k)',
    'Cache written': '48.0k',
  });
  expect(rows).not.toHaveProperty('Stopped');
  expect(rows).not.toHaveProperty('Started by');
  const unusual = Object.fromEntries(
    turnDetails(
      turn({
        status: 'failed',
        source: 'schedule',
        profile: 'backup',
        error: { type: 'urn:x', detail: 'The provider is unavailable.' },
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      }),
      now,
    ).map((row) => [row.label, row.value]),
  );
  expect(unusual).toMatchObject({
    'Started by': 'Schedule',
    'Fallback profile': 'backup',
    Error: 'The provider is unavailable.',
  });
  expect(unusual).not.toHaveProperty('Tokens in');
});
