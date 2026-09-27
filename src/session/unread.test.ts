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
  patch: Partial<Parameters<typeof sessionStatus>[0]> & { updated_at?: string } = {},
) =>
  sessionStatus({
    session: session('other', patch.updated_at ?? '2026-09-26T11:00:00Z'),
    live: undefined,
    running: false,
    seen,
    selected: false,
    ...patch,
  });
const approval = {
  id: 'r',
  sessionId: 'other',
  turnId: 't',
  tool: 'shell_execute',
  input: {},
  expires: 0,
};
const followed = (outcome: 'completed' | 'failed' | 'canceled', updatedAt?: string) => ({
  approvals: [],
  lastTurn: { outcome, updatedAt },
});

it('puts a pending approval ahead of running, and running ahead of unread', () => {
  expect(status({ live: { approvals: [approval], lastTurn: undefined }, running: true })).toBe(
    'approval',
  );
  expect(status({ running: true })).toBe('running');
});
it('colours unread sessions by the outcome this tab followed', () => {
  expect(status({ live: followed('completed', '2026-09-26T11:00:00Z') })).toBe('completed');
  expect(status({ live: followed('failed', '2026-09-26T11:00:00Z') })).toBe('failed');
  expect(status({ live: followed('failed') })).toBe('failed');
  expect(status({ live: followed('canceled', '2026-09-26T11:00:00Z') })).toBe('unread');
  expect(status()).toBe('unread');
});
it('drops an outcome that later activity superseded', () => {
  expect(
    status({
      live: followed('failed', '2026-09-26T11:00:00Z'),
      updated_at: '2026-09-26T11:30:00Z',
    }),
  ).toBe('unread');
});
it('shows read sessions, the open one, and sub-agents plainly', () => {
  expect(status({ updated_at: '2026-09-26T09:00:00Z', live: followed('failed') })).toBe('read');
  expect(status({ selected: true, live: followed('completed') })).toBe('read');
  expect(
    sessionStatus({
      session: session('other', '2026-09-26T11:00:00Z', 'parent'),
      live: followed('failed'),
      running: false,
      seen,
      selected: false,
    }),
  ).toBe('read');
});
