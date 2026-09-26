import { useAction } from './components/actions';
import { useEffect, useRef, useState, Suspense } from 'react';
import { Outlet, useLocation } from '@tanstack/react-router';
import {
  BookOpen,
  CalendarClock,
  ChevronDown,
  Menu,
  MessageSquare,
  Plug,
  Settings,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { ConnectionRuntime } from './connections/runtime';
import { RuntimeContext, useConnection, useRuntime, useSettings } from './connections/context';
import { Welcome } from './features/settings';
import { useSessionStates } from './session/hooks';
import type { Approval } from './session/controller';
import type { Schema } from './api/client';
import { Button } from './components/ui/button';
import { Dialog } from './components/ui/dialog';
import { ErrorNotice, Json, Loading } from './components/common';
import { NavigationToggle } from './components/layout';
import { ConnectionBanner } from './components/connection-banner';
import { trackFocusInput } from './components/focus-input';
import { NotificationToasts } from './notifications/toasts';
import { useVisualViewport } from './components/visual-viewport';
import { KeyboardShortcutsButton, KeyboardShortcutsDialog } from './components/shortcuts';
import { useShortcut } from './components/use-shortcut';
import { SessionNavigationContext } from './features/session-navigation';
import { useNewConversation } from './features/use-new-conversation';
import { supportsSessionOrganization } from './api/version';

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
  function newSession() {
    if (!canCreate) return;
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
  useShortcut('newSession', newSession, canCreate);
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
    Boolean(
      state.api &&
      state.info?.scopes.includes('sessions:r') &&
      supportsSessionOrganization(state.info.version),
    ),
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
  useEffect(() => {
    if (!state.controller) return;
    const controller = state.controller;
    const refresh = () => {
      for (const session of controller.getSnapshot())
        if (session.feed === 'connected' && !session.running) void controller.refresh(session.id);
    };
    const timer = setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [state.controller]);
  if (!state.api)
    return (
      <>
        <Welcome />
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
          {settings.layout.navigationCollapsed && (
            <KeyboardShortcutsButton collapsed onClick={openKeymap} />
          )}
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
            <span className="muted small">{state.connection?.name}</span>
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
                <ApprovalCard key={approval.id} approval={approval} />
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
  const runtime = useRuntime();
  const settings = useSettings();
  const location = useLocation();
  const entries = [
    { name: 'Sessions', path: '/sessions', icon: MessageSquare, scope: 'sessions:r' },
    { name: 'Memory', path: '/memory', icon: BookOpen, scope: 'memory:r' },
    { name: 'Skills', path: '/skills', icon: Sparkles },
    { name: 'Schedules', path: '/schedules', icon: CalendarClock, scope: 'schedule:r' },
    { name: 'MCP', path: '/mcp', icon: Plug },
    { name: 'Settings', path: '/settings', icon: Settings },
  ];
  return (
    <>
      <div className="navigation-heading">
        <a href="#/sessions" className="brand" onClick={onNavigate}>
          <span>meka</span>
        </a>
        {!onNavigate && <NavigationToggle />}
      </div>
      {settings.connections.length > 1 && (
        <div className="connection-switcher">
          <label className="sr-only" htmlFor={onNavigate ? 'mobile-connection' : 'connection'}>
            Active connection
          </label>
          <select
            id={onNavigate ? 'mobile-connection' : 'connection'}
            value={state.connection?.id ?? ''}
            onChange={(event) => {
              const record = settings.connections.find((c) => c.id === event.target.value);
              if (record) void runtime.connect(record);
              onNavigate?.();
            }}
          >
            {settings.connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </div>
      )}
      <nav aria-label="Main navigation">
        {entries
          .filter((entry) => !entry.scope || state.info?.scopes.includes(entry.scope))
          .map((entry) => {
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
          })}
      </nav>
      <KeyboardShortcutsButton onClick={onShortcuts} />
    </>
  );
}
function ApprovalCard({ approval }: { approval: Approval }) {
  const { controller, connection } = useConnection();
  const action = useAction();
  return (
    <section className="approval-card">
      <header>
        <ShieldCheck size={20} />
        <h2>Approval needed</h2>
      </header>
      <p className="muted small">
        {connection?.name} ·{' '}
        <a href={`#/sessions/${approval.sessionId}`}>Session {approval.sessionId.slice(0, 8)}</a>
      </p>
      <h3>{approval.tool}</h3>
      <details open>
        <summary>Full arguments</summary>
        <Json value={approval.input} />
      </details>
      <p className="muted small">Expires at {new Date(approval.expires).toLocaleTimeString()}.</p>
      <ErrorNotice error={action.error} />
      <div className="approval-actions">
        {(
          [
            ['allow', 'Allow once'],
            ['deny', 'Deny once'],
            ['allow_always', 'Always allow'],
            ['deny_always', 'Always deny'],
          ] satisfies [Schema['PermissionDecision'], string][]
        ).map(([outcome, label]) => (
          <Button
            key={outcome}
            variant={outcome === 'allow' ? 'default' : 'secondary'}
            size="sm"
            disabled={action.busy || !controller?.canWrite}
            title={!controller?.canWrite ? 'Requires sessions:w' : undefined}
            onClick={() => void action.run(async () => controller?.respond(approval, outcome))}
          >
            {label}
          </Button>
        ))}
      </div>
    </section>
  );
}
