import { expect, it } from 'vitest';
import { isUnread, sessionStatus } from './unread';

const seen = {
  baseline: '2026-09-26T10:00:00Z',
  sessions: { viewed: '2026-09-26T12:00:00Z' },
};
const session = (id: string, updated_at: string, parent_id?: string) => ({
  id,
  updated_at,
  ...(parent_id ? { parent_id } : {}),
});

it('marks sessions changed since they were viewed, or since tracking began', () => {
  expect(isUnread(session('viewed', '2026-09-26T12:00:00Z'), seen, false)).toBe(false);
  expect(isUnread(session('viewed', '2026-09-26T12:00:01Z'), seen, false)).toBe(true);
  expect(isUnread(session('other', '2026-09-26T09:00:00Z'), seen, false)).toBe(false);
  expect(isUnread(session('other', '2026-09-26T11:00:00Z'), seen, false)).toBe(true);
});
it('compares instants rather than strings', () => {
  expect(isUnread(session('viewed', '2026-09-26T13:00:00+02:00'), seen, false)).toBe(false);
});
it('leaves running sessions, sub-agents, and untracked connections unmarked', () => {
  expect(isUnread(session('other', '2026-09-26T11:00:00Z'), seen, true)).toBe(false);
  expect(isUnread(session('other', '2026-09-26T11:00:00Z', 'parent'), seen, false)).toBe(false);
  expect(isUnread(session('other', '2026-09-26T11:00:00Z'), { sessions: {} }, false)).toBe(false);
});

const status = (
  patch: Partial<Parameters<typeof sessionStatus>[0]> & {
    updated_at?: string;
    record?: Partial<Parameters<typeof sessionStatus>[0]['session']>;
  } = {},
) =>
  sessionStatus({
    live: undefined,
    running: false,
    seen,
    selected: false,
    ...patch,
    session: {
      ...session('other', patch.updated_at ?? '2026-09-26T11:00:00Z'),
      ...patch.record,
    },
  });
const approval = {
  id: 'r',
  sessionId: 'other',
  turnId: 't',
  tool: 'shell_execute',
  input: {},
  expires: 0,
};
const lastTurn = (status: string, ended = true) => ({
  last_turn: {
    id: 't',
    source: 'client',
    started_at: '2026-09-26T10:59:00Z',
    ...(ended ? { ended_at: '2026-09-26T11:00:00Z', status } : {}),
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
});

it('puts a pending approval ahead of running, and running ahead of unread', () => {
  expect(status({ live: { approvals: [approval] }, running: true })).toBe('approval');
  expect(status({ record: { approvals_pending: 1 }, running: true })).toBe('approval');
  expect(status({ record: { approvals_pending: 0 }, running: true })).toBe('running');
  expect(status({ running: true })).toBe('running');
});
it('colours unread sessions by how their last turn ended', () => {
  expect(status({ record: lastTurn('succeeded') })).toBe('completed');
  expect(status({ record: lastTurn('failed') })).toBe('failed');
  expect(status({ record: lastTurn('canceled') })).toBe('unread');
  expect(status()).toBe('unread');
});
it('leaves an unfinished turn that is not running without an outcome', () => {
  expect(status({ record: lastTurn('succeeded', false) })).toBe('unread');
});
it('shows read sessions, the open one, and sub-agents plainly', () => {
  expect(status({ updated_at: '2026-09-26T09:00:00Z', record: lastTurn('failed') })).toBe('read');
  expect(status({ selected: true, record: lastTurn('succeeded') })).toBe('read');
  expect(status({ record: { ...lastTurn('failed'), parent_id: 'parent' } })).toBe('read');
});

it('does not show an outcome already seen as news when a later change makes it unread', () => {
  // Seen at 12:00, after the turn ended at 11:00; a profile switch at 12:30 makes it unread.
  expect(
    status({
      record: { ...lastTurn('succeeded'), id: 'viewed' },
      updated_at: '2026-09-26T12:30:00Z',
    }),
  ).toBe('unread');
});
