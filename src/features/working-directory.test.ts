import { describe, expect, it } from 'vitest';
import { directoryLabel, recentDirectories, sameDirectory } from './working-directory';

const session = (cwd: string | null | undefined, updated_at: string) =>
  cwd === undefined ? { updated_at } : { cwd, updated_at };

describe('recent directories', () => {
  it('orders by update time and removes duplicates', () => {
    expect(
      recentDirectories([
        session('/srv', '2026-09-23T10:00:00Z'),
        session('/home/user/project', '2026-09-26T02:00:00Z'),
        session('/home/user/other', '2026-09-25T20:00:00Z'),
        session('/home/user/project/', '2026-09-25T10:00:00Z'),
      ]),
    ).toEqual(['/home/user/project', '/home/user/other', '/srv']);
  });

  it('skips sessions without a directory and respects the limit', () => {
    expect(
      recentDirectories(
        [
          session(undefined, '2026-09-26T00:00:00Z'),
          session(null, '2026-09-26T00:00:00Z'),
          session('  ', '2026-09-26T00:00:00Z'),
          session('/a', '2026-09-25T00:00:00Z'),
          session('/b', '2026-09-24T00:00:00Z'),
          session('/c', '2026-09-23T00:00:00Z'),
        ],
        2,
      ),
    ).toEqual(['/a', '/b']);
  });

  it('keeps the server order for equal or unreadable timestamps', () => {
    expect(
      recentDirectories([
        session('/first', 'invalid'),
        session('/second', 'invalid'),
        session('/third', '2026-09-26T00:00:00Z'),
      ]),
    ).toEqual(['/third', '/first', '/second']);
  });
});

describe('directory labels', () => {
  it('separates the final component from its parent', () => {
    expect(directoryLabel('/home/user/project')).toEqual({
      name: 'project',
      parent: '/home/user',
    });
    expect(directoryLabel('/home/user/project/')).toEqual({
      name: 'project',
      parent: '/home/user',
    });
    expect(directoryLabel('/srv')).toEqual({ name: 'srv', parent: '/' });
    expect(directoryLabel('C:\\Users\\user')).toEqual({ name: 'user', parent: 'C:\\Users' });
  });

  it('keeps roots and bare names whole', () => {
    expect(directoryLabel('/')).toEqual({ name: '/', parent: '' });
    expect(directoryLabel('//')).toEqual({ name: '/', parent: '' });
    expect(directoryLabel('C:\\')).toEqual({ name: 'C:\\', parent: '' });
    expect(directoryLabel('project')).toEqual({ name: 'project', parent: '' });
  });

  it('compares directories without trailing separators', () => {
    expect(sameDirectory('/home/user/project/', ' /home/user/project')).toBe(true);
    expect(sameDirectory('/home/user/project', '/home/user/projects')).toBe(false);
  });
});
