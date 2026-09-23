import { expect, it } from 'vitest';
import { sessionNotice } from './notices';

it.each([
  ['info', 'info'],
  ['warn', 'warning'],
  ['warning', 'warning'],
  ['error', 'error'],
  [undefined, 'warning'],
])('preserves the severity of a %s server notice', (level, expected) => {
  expect(sessionNotice('notice', { text: 'Server advisory', level, turn_id: 'turn' })).toEqual({
    event: 'notice',
    level: expected,
    text: 'Server advisory',
    turnId: 'turn',
  });
});

it('suppresses routine cancellation and empty notices without hiding other interruptions', () => {
  expect(sessionNotice('turn.canceled', { reason: 'client' })).toBeUndefined();
  expect(sessionNotice('turn.canceled', {})).toBeUndefined();
  expect(sessionNotice('notice', { text: ' \n ' })).toBeUndefined();
  expect(sessionNotice('turn.canceled', { reason: 'server_shutdown' })).toMatchObject({
    level: 'warning',
    text: 'The turn stopped because the meka server shut down.',
  });
  expect(sessionNotice('turn.canceled', { reason: 'sse_lag' })?.text).toContain(
    'reader fell behind',
  );
  expect(sessionNotice('turn.canceled', { reason: 'future reason' })?.text).toContain(
    'future reason',
  );
});

it('presents terminal failures and refusals while leaving tool errors in their own cards', () => {
  expect(
    sessionNotice('turn.failed', { error: { detail: 'Provider unavailable', title: 'Error' } }),
  ).toMatchObject({ level: 'error', text: 'Provider unavailable' });
  expect(sessionNotice('turn.failed', { error: { title: 'Provider unavailable' } })?.text).toBe(
    'Provider unavailable',
  );
  expect(sessionNotice('turn.failed', {})?.text).toBe('The turn failed.');
  expect(sessionNotice('turn.finished', { refusal_text: 'Request declined' })).toMatchObject({
    level: 'warning',
    text: 'Request declined',
  });
  expect(sessionNotice('turn.finished', {})).toBeUndefined();
  expect(
    sessionNotice('tool_call.completed', {
      is_error: true,
      content: [{ type: 'text', text: 'Failed' }],
    }),
  ).toBeUndefined();
});
