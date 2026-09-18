import { lazy } from 'react';
export const SessionsPage = lazy(() =>
  import('./sessions').then((module) => ({ default: module.SessionsPage })),
);
export const SessionRoute = lazy(() =>
  import('./sessions').then((module) => ({ default: module.SessionRoute })),
);
export const ResourcesPage = lazy(() =>
  import('./resources').then((module) => ({ default: module.ResourcesPage })),
);
export const SchedulesPage = lazy(() =>
  import('./schedules').then((module) => ({ default: module.SchedulesPage })),
);
export const McpPage = lazy(() => import('./mcp').then((module) => ({ default: module.McpPage })));
