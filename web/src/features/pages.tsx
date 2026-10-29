import { lazy } from 'react';
export const SessionRoute = lazy(() =>
  import('./sessions').then((module) => ({ default: module.SessionRoute })),
);
export const ResourcesPage = lazy(() =>
  import('./resources').then((module) => ({ default: module.ResourcesPage })),
);
export const SchedulesPage = lazy(() =>
  import('./schedules').then((module) => ({ default: module.SchedulesPage })),
);
export const ProjectsPage = lazy(() =>
  import('./projects').then((module) => ({ default: module.ProjectsPage })),
);
export const McpPage = lazy(() => import('./mcp').then((module) => ({ default: module.McpPage })));
export const ProvidersPage = lazy(() =>
  import('./providers').then((module) => ({ default: module.ProvidersPage })),
);
