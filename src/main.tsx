import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import {
  SessionsPage,
  SessionRoute,
  ResourcesPage,
  SchedulesPage,
  McpPage,
} from './features/pages';
import { ConnectionRuntime } from './connections/runtime';
import { browserStorage } from './connections/storage';

import { SettingsPage } from './features/settings';
import './styles.css';
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const runtime = new ConnectionRuntime(browserStorage(), queryClient);
const rootRoute = createRootRoute({
  component: () => <App runtime={runtime} />,
  notFoundComponent: () => (
    <div className="page">
      <h1>Page not found</h1>
      <a href="#/">Return to meka</a>
    </div>
  ),
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <SessionsPage />,
});
const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  component: () => <SessionsPage />,
});
const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/$sessionId',
  component: SessionRoute,
});
const routes = [
  indexRoute,
  sessionsRoute,
  sessionRoute,
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/memory',
    component: () => <ResourcesPage kind="memory" />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/skills',
    component: () => <ResourcesPage kind="skills" />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/schedules',
    component: () => <SchedulesPage />,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/mcp', component: McpPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage }),
];
const router = createRouter({
  history: createHashHistory(),
  routeTree: rootRoute.addChildren(routes),
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('The application root element is missing.');
createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
