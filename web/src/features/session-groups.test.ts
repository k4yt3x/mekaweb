import { expect, it } from 'vitest';
import {
  PINNED,
  UNPROJECTED,
  groupName,
  groupOf,
  projectGroup,
  sessionGroups,
} from './session-groups';

it('lists the pinned first, then each project with sessions by name, then those on none', () => {
  const groups = sessionGroups(
    [
      { name: 'web', sessions: 2 },
      { name: 'Api', sessions: 1 },
      { name: 'empty', sessions: 0 },
    ],
    [{ project: '' }],
    true,
  );
  expect(groups.map(groupName)).toEqual(['Pinned', 'Api', 'web', 'No project']);
  expect(groups.map((group) => group.count)).toEqual([undefined, 1, 2, undefined]);
});

it('counts a project’s pinned sessions with the pinned, dropping a project of only those', () => {
  const groups = sessionGroups(
    [
      { name: 'web', sessions: 3 },
      { name: 'docs', sessions: 1 },
    ],
    [{ project: 'web' }, { project: 'docs' }],
    false,
  );
  expect(groups).toEqual([PINNED, { key: 'project:web', project: 'web', count: 2 }]);
});

it('leaves out the pinned and those on none when there are none', () => {
  expect(sessionGroups([{ name: 'web', sessions: 1 }], [], false).map(groupName)).toEqual(['web']);
});

it('puts a session in its group by its pin, then its project', () => {
  expect(groupOf({ pinned_at: '2026-11-02T00:00:00Z', project: 'web' })).toBe(PINNED.key);
  expect(groupOf({ project: 'web' })).toBe('project:web');
  expect(groupOf({ project: '' })).toBe(UNPROJECTED.key);
  expect(projectGroup('')).toBe(UNPROJECTED);
});
