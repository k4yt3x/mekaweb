import { useAction } from './components/actions';
import { useEffect, useState, Suspense } from 'react';
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

export function App({ runtime }: { runtime: ConnectionRuntime }) {
  useEffect(() => runtime.start(), [runtime]);
  return (
    <RuntimeContext.Provider value={runtime}>
      <Shell />
    </RuntimeContext.Provider>
  );
}
function Shell() {
  const state = useConnection();
  const runtime = useRuntime();
  const settings = useSettings();
  const [nav, setNav] = useState(false);
  const location = useLocation();
  const sessions = useSessionStates();
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.classList.toggle(
        'dark',
        settings.theme === 'dark' || (settings.theme === 'system' && media.matches),
      );
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
      <aside id="workspace-navigation" className="app-sidebar" aria-label="Workspace navigation">
        <Navigation />
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
        <span className="muted small">{state.connection?.name}</span>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="main-content"
        key={state.connection?.id + ':' + state.connection?.authority}
      >
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
      <Dialog open={nav} onOpenChange={setNav} title="Navigation" placement="left">
        <Navigation onNavigate={() => setNav(false)} />
      </Dialog>
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
  );
}
function Navigation({ onNavigate }: { onNavigate?: () => void }) {
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
