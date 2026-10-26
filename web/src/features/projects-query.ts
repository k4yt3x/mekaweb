import type { Schema } from '../api/client';
import { useResource } from '../connections/context';

/** meka's projects: each is a memory tier, which the sessions on it see beside the global one. */
export function useProjects(enabled = true) {
  return useResource<Schema['ProjectsResponse']>('/v1/projects', undefined, enabled);
}

/** The names of meka's projects, with one a record names kept even after it is gone. */
export function projectNames(projects: Schema['ProjectsResponse'] | undefined, current = '') {
  const names = projects?.projects.map((project) => project.name) ?? [];
  return current && !names.includes(current) ? [current, ...names] : names;
}
