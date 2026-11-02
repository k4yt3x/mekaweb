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
import { SessionRoute } from './features/pages';
import { SettingsRoute } from './features/settings-dialog';
import { SIDEBAR_PAGES } from './features/sidebar-pages';
import type { SettingsSection } from './components/settings-control';
import { ConnectionRuntime } from './connections/runtime';
import { browserStorage } from './connections/storage';
import 'katex/contrib/copy-tex';
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
// The sessions routes share a component, so React keeps one sessions page across them: starting
// a conversation moves to its session without remounting the page or suspending it to load.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: SessionRoute,
});
const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  component: SessionRoute,
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
  // The sidebar's pages share the sessions' component too, so the sidebar stays as they change.
  ...SIDEBAR_PAGES.map(({ path }) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: SessionRoute }),
  ),
  // These pages are sections of Settings now; their addresses open them.
  ...(
    [
      ['/mcp', 'mcp'],
      ['/providers', 'providers'],
      ['/settings', 'general'],
    ] as const satisfies readonly (readonly [string, SettingsSection])[]
  ).map(([path, section]) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => <SettingsRoute section={section} />,
    }),
  ),
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
// A page left open across an upgrade asks for parts of the old build, which are gone: it loads the
// new one instead, at most once a minute so a part missing from the new build cannot loop.
window.addEventListener('vite:preloadError', (event) => {
  try {
    const key = 'mekaweb:reloaded-for-update';
    if (Date.now() - Number(sessionStorage.getItem(key) ?? 0) < 60_000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    // Without session storage, a reload could not tell itself from the last.
    return;
  }
  event.preventDefault();
  location.reload();
});
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('The application root element is missing.');
createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
