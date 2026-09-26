import type { Schema } from '../api/client';

const driveRoot = /^[A-Za-z]:[\\/]$/;

function trimSeparators(path: string) {
  const trimmed = path.trim();
  if (trimmed.length <= 1 || driveRoot.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/, '') || trimmed.slice(0, 1);
}

/** Distinct working directories of the given sessions, most recently updated first. */
export function recentDirectories(
  sessions: Pick<Schema['SessionResponse'], 'cwd' | 'updated_at'>[],
  limit = 6,
) {
  const time = (value: string) => Date.parse(value) || 0;
  const directories = new Set<string>();
  // Array.prototype.sort is stable, so equal timestamps keep the server's order.
  for (const session of [...sessions].sort((a, b) => time(b.updated_at) - time(a.updated_at))) {
    const path = session.cwd ? trimSeparators(session.cwd) : '';
    if (path) directories.add(path);
    if (directories.size >= limit) break;
  }
  return [...directories];
}

/** Splits a server path into its final component and the directory containing it. */
export function directoryLabel(path: string) {
  const trimmed = trimSeparators(path);
  if (trimmed.length <= 1 || driveRoot.test(trimmed)) return { name: trimmed, parent: '' };
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (index < 0) return { name: trimmed, parent: '' };
  return {
    name: trimmed.slice(index + 1),
    parent: trimmed.slice(0, index) || trimmed.slice(0, 1),
  };
}

export function sameDirectory(a: string, b: string) {
  return trimSeparators(a) === trimSeparators(b);
}
