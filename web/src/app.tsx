import { useEffect, useRef, useState, Suspense } from 'react';
import { Outlet, useLocation } from '@tanstack/react-router';
import {
  BookOpen,
  BrainCircuit,
  CalendarClock,
  FolderKanban,
  Menu,
  MessageSquare,
  Plug,
  Settings,
  Sparkles,
} from 'lucide-react';
import type { ConnectionRuntime } from './connections/runtime';
import { RuntimeContext, useConnection, useRuntime, useSettings } from './connections/context';
import { SignIn } from './features/sign-in';
import { Unavailable } from './features/unavailable';
import { useSessionStates } from './session/hooks';
import { Button } from './components/ui/button';
import { Dialog } from './components/ui/dialog';
import { ErrorNotice, Loading } from './components/common';
import { NavigationToggle } from './components/layout';
import { ConnectionBanner } from './components/connection-banner';
import { AccountMenu } from './components/account-menu';
import { trackFocusInput } from './components/focus-input';
import { NotificationToasts } from './notifications/toasts';
import { useVisualViewport } from './components/visual-viewport';
import { KeyboardShortcutsButton, KeyboardShortcutsDialog } from './components/shortcuts';
import { useShortcut } from './components/use-shortcut';
import { SessionNavigationContext } from './features/session-navigation';
import { useNewConversation } from './features/use-new-conversation';
import { PromptCard } from './features/approval-cards';

export function App({ runtime }: { runtime: ConnectionRuntime }) {
  useEffect(trackFocusInput, []);
  useEffect(() => runtime.start(), [runtime]);
  return (
    <RuntimeContext.Provider value={runtime}>
      <Shell />
      <NotificationToasts />
    </RuntimeContext.Provider>
  );
}
function Shell() {
  const { connection } = useConnection();
  // The single remount point for connection or credential changes; nothing below needs its own key.
  return <Workspace key={connection?.id + ':' + connection?.authority} />;
}
function Workspace() {
  useVisualViewport();
  const state = useConnection();
  const runtime = useRuntime();
  const settings = useSettings();
  const [nav, setNav] = useState(false);
  const location = useLocation();
  const sessions = useSessionStates();
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [searchRequested, setSearchRequested] = useState(false);
  const [keymap, setKeymap] = useState(false);
  const keymapFocus = useRef<HTMLElement | null>(null);
  const composerFocusRef = useRef<string | null>(null);
  useEffect(() => {
    const expected =
      composerFocusRef.current === 'new' ? '/sessions' : '/sessions/' + composerFocusRef.current;
    if (
      composerFocusRef.current &&
      location.pathname !== expected &&
      !(composerFocusRef.current === 'new' && location.pathname === '/')
    )
      composerFocusRef.current = null;
  }, [location.pathname]);
  const canCreate = Boolean(state.api && state.info?.scopes.includes('sessions:w'));
  const newConversation = useNewConversation((id) => {
    if (['', '#/', '#/sessions'].includes(window.location.hash)) {
      composerFocusRef.current = id;
      setMobileSessionsOpen(false);
      window.location.hash = '/sessions/' + id;
    }
  });
  /** Opens a new session set up like the one in view, or with the server's defaults when none is,
   * so pressing it again starts from the defaults. */
  function newSession(workingDirectory?: string) {
    if (!canCreate) return;
    const inView = /^\/sessions\/([^/]+)$/.exec(location.pathname)?.[1];
    newConversation.prepare(
      sessions.find((session) => session.id === inView && !session.deleting)?.session,
      workingDirectory,
    );
    setSearchRequested(false);
    setMobileSessionsOpen(false);
    composerFocusRef.current = 'new';
    if (location.pathname !== '/' && location.pathname !== '/sessions')
      window.location.hash = '/sessions';
    else {
      const input = document.querySelector<HTMLTextAreaElement>(
        '.new-conversation textarea[aria-label="Message"]',
      );
      if (input && !input.disabled && input.getClientRects().length) {
        composerFocusRef.current = null;
        input.focus();
      }
    }
  }
  function openKeymap() {
    keymapFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setNav(false);
    setKeymap(true);
  }
  useShortcut('newSession', () => newSession(), canCreate);
  useShortcut(
    'searchSessions',
    () => {
      composerFocusRef.current = null;
      setSearchRequested(true);
      setMobileSessionsOpen(true);
      if (
        location.pathname !== '/' &&
        location.pathname !== '/sessions' &&
        !location.pathname.startsWith('/sessions/')
      )
        window.location.hash = '/sessions';
    },
    Boolean(state.api && state.info?.scopes.includes('sessions:r')),
  );
  useShortcut(
    'showShortcuts',
    () => {
      if (keymap) setKeymap(false);
      else openKeymap();
    },
    Boolean(state.api),
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.classList.toggle(
        'dark',
        settings.theme === 'dark' || (settings.theme === 'system' && media.matches),
      );
      const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (themeColor)
        themeColor.content = getComputedStyle(document.documentElement)
          .getPropertyValue('--bg')
          .trim();
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [settings.theme]);
  useEffect(() => {
    if (!state.controller) return;
    const controller = state.controller;
    const timer = setInterval(() => {
      controller.expireApprovals();
    }, 1000);
    return () => clearInterval(timer);
  }, [state.controller]);
  // The app icon's badge counts the approvals waiting, as push notifications set it.
  const waiting = sessions.reduce((sum, s) => sum + s.approvals.length, 0);
  useEffect(() => {
    const badge = navigator as Navigator & {
      setAppBadge?: (count: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    const update = waiting > 0 ? badge.setAppBadge?.(waiting) : badge.clearAppBadge?.();
    update?.catch(() => {});
  }, [waiting]);
  useEffect(() => {
    if (!state.controller) return;
    const controller = state.controller;
    const refresh = () => {
      // An unloaded session has no feed to report changes, such as another process's turns.
      for (const session of controller.getSnapshot())
        if (['connected', 'unloaded'].includes(session.feed) && !session.running)
          void controller.refresh(session.id);
    };
    // Only what came after the messages held is read, so this costs a request or two.
    const timer = setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [state.controller]);
  if (!state.api)
    return (
      <>
        {state.auth === 'signed-out' ? (
          <SignIn />
        ) : state.auth === 'signed-in' ? (
          <Unavailable />
        ) : (
          <main className="welcome">
            <section className="connection-card" aria-label="mekaweb">
              <h1>meka</h1>
              {state.error ? (
                <>
                  <ErrorNotice error={new Error(state.error)} />
                  <Button onClick={() => void runtime.check()}>Try again</Button>
                </>
              ) : (
                <Loading />
              )}
            </section>
          </main>
        )}
        {runtime.storage.warning && (
          <p className="storage-warning" role="status">
            {runtime.storage.warning}
          </p>
        )}
      </>
    );
  return (
    <SessionNavigationContext.Provider
      value={{
        newSession,
        searchRequested,
        finishSearch: () => setSearchRequested(false),
        composerFocusRef,
        mobileSessionsOpen,
        setMobileSessionsOpen,
        newConversation,
      }}
    >
      <div className="app-frame">
        <ConnectionBanner />
        <div
          className={`app-shell ${settings.layout.navigationCollapsed ? 'navigation-collapsed' : ''}`}
        >
          <a
            href="#main-content"
            className="skip-link"
            onClick={(event) => {
              event.preventDefault();
              document.getElementById('main-content')?.focus();
            }}
          >
            Skip to content
          </a>
          <aside
            id="workspace-navigation"
            className="app-sidebar"
            aria-label="Workspace navigation"
          >
            <Navigation onShortcuts={openKeymap} />
          </aside>
          {settings.layout.navigationCollapsed &&
            (!state.info?.scopes.includes('sessions:r') ||
              (!location.pathname.startsWith('/sessions') && location.pathname !== '/')) && (
              <NavigationToggle className="navigation-restore" />
            )}
          <header className="mobile-header">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open navigation"
              onClick={() => setNav(true)}
            >
              <Menu size={20} />
            </Button>
            <strong>meka</strong>
          </header>
          <main id="main-content" tabIndex={-1} className="main-content">
            <Suspense
              fallback={
                <div className="page">
                  <Loading />
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </main>
          <Dialog
            open={nav}
            onOpenChange={setNav}
            title="Navigation"
            placement="left"
            onCloseAutoFocus={(event) => {
              if (keymap) event.preventDefault();
            }}
          >
            <Navigation onNavigate={() => setNav(false)} onShortcuts={openKeymap} />
          </Dialog>
          <KeyboardShortcutsDialog
            open={keymap}
            onOpenChange={setKeymap}
            returnFocus={keymapFocus}
          />
          {runtime.storage.warning && (
            <p className="storage-warning" role="status">
              {runtime.storage.warning}
            </p>
          )}
          <div className="approval-tray" role="region" aria-label="Pending approvals">
            {sessions
              .flatMap((s) => s.approvals)
              .map((approval) => (
                <PromptCard key={approval.id} approval={approval} />
              ))}
          </div>
          <span className="sr-only" aria-live="polite">
            {sessions.reduce((sum, s) => sum + s.approvals.length, 0)} approvals waiting.{' '}
            {location.pathname.split('/')[1] || 'Sessions'} view.
          </span>
        </div>
      </div>
    </SessionNavigationContext.Provider>
  );
}
function Navigation({
  onNavigate,
  onShortcuts,
}: {
  onNavigate?: () => void;
  onShortcuts: () => void;
}) {
  const state = useConnection();
  const location = useLocation();
  const entries = [
    // By how often each is used, related pages together; the setup pages last.
    { name: 'Sessions', path: '/sessions', icon: MessageSquare, scope: 'sessions:r' },
    { name: 'Projects', path: '/projects', icon: FolderKanban },
    { name: 'Memories', path: '/memory', icon: BookOpen, scope: 'memory:r' },
    { name: 'Skills', path: '/skills', icon: Sparkles },
    { name: 'Schedules', path: '/schedules', icon: CalendarClock, scope: 'schedule:r' },
    { name: 'MCP', path: '/mcp', icon: Plug },
    { name: 'Providers', path: '/providers', icon: BrainCircuit },
    { name: 'Settings', path: '/settings', icon: Settings },
  ];
  const pages = entries.filter((entry) => !entry.scope || state.info?.scopes.includes(entry.scope));
  const link = (entry: (typeof entries)[number]) => {
    const active =
      location.pathname.startsWith(entry.path) ||
      (entry.path === '/sessions' && location.pathname === '/');
    return (
      <a
        href={'#' + entry.path}
        key={entry.path}
        className={active ? 'active' : ''}
        aria-current={active ? 'page' : undefined}
        onClick={onNavigate}
      >
        <entry.icon size={18} />
        {entry.name}
      </a>
    );
  };
  return (
    <>
      <div className="navigation-heading">
        <a href="#/sessions" className="brand" onClick={onNavigate}>
          <span>meka</span>
        </a>
        {!onNavigate && <NavigationToggle />}
      </div>
      <nav aria-label="Main navigation">
        {pages.filter((entry) => entry.path !== '/settings').map(link)}
        <KeyboardShortcutsButton onClick={onShortcuts} />
        {pages.filter((entry) => entry.path === '/settings').map(link)}
      </nav>
      <AccountMenu onNavigate={onNavigate} />
    </>
  );
}
