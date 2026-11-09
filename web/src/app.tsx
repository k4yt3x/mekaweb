import { useCallback, useEffect, useRef, useState, Suspense } from 'react';
import { Outlet, useLocation } from '@tanstack/react-router';
import type { ConnectionRuntime } from './connections/runtime';
import { RuntimeContext, useConnection, useRuntime, useSettings } from './connections/context';
import { SignIn } from './features/sign-in';
import { Unavailable } from './features/unavailable';
import { useSessionStates } from './session/hooks';
import { Button } from './components/ui/button';
import { ErrorNotice, Loading } from './components/common';
import { ConnectionBanner } from './components/connection-banner';
import { trackFocusInput } from './components/focus-input';
import { NotificationToasts } from './notifications/toasts';
import { useVisualViewport } from './components/visual-viewport';
import { useShortcut } from './components/use-shortcut';
import { SettingsControl, type SettingsSection } from './components/settings-control';
import { SettingsDialog } from './features/settings-dialog';
import { sidebarPage } from './features/sidebar-pages';
import { SessionNavigationContext } from './features/session-navigation';
import { useNewConversation, type NewSessionSetup } from './features/use-new-conversation';
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
  const location = useLocation();
  const sessions = useSessionStates();
  // Meka's server feed, followed on every page: the session list reads it, and any turn ending
  // alerts by it.
  useEffect(() => state.controller?.followServer(), [state.controller]);
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [searchRequested, setSearchRequested] = useState(false);
  // Settings, open over whatever is shown, at its section.
  const [settingsShown, setSettingsShown] = useState<SettingsSection>();
  const openSettings = useCallback(
    (section: SettingsSection = 'general') => setSettingsShown(section),
    [],
  );
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
   * so pressing it again starts from the defaults; `setup` overrides either. */
  function newSession(setup?: NewSessionSetup) {
    if (!canCreate) return;
    const inView = /^\/sessions\/([^/]+)$/.exec(location.pathname)?.[1];
    newConversation.prepare(
      sessions.find((session) => session.id === inView && !session.deleting)?.session,
      setup,
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
  useShortcut('newSession', () => newSession(), canCreate);
  useShortcut(
    'searchSessions',
    () => {
      composerFocusRef.current = null;
      setSearchRequested(true);
      setMobileSessionsOpen(true);
      // The sidebar's pages show the sessions beside them; anywhere else goes to them.
      if (
        location.pathname !== '/' &&
        location.pathname !== '/sessions' &&
        !location.pathname.startsWith('/sessions/') &&
        !sidebarPage(location.pathname)
      )
        window.location.hash = '/sessions';
    },
    Boolean(state.api && state.info?.scopes.includes('sessions:r')),
  );
  // The shortcuts are a section of Settings, which the same keys close again.
  useShortcut(
    'showShortcuts',
    () => setSettingsShown((shown) => (shown === 'shortcuts' ? undefined : 'shortcuts')),
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
            <section className="connection-card" aria-label="Meka Studio">
              <h1>Meka Studio</h1>
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
    <SettingsControl.Provider value={openSettings}>
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
          <div className="app-shell">
            <a
              href="#main-content"
              className="skip-link"
              onClick={(event) => {
                event.preventDefault();
                // Past the sidebar, to the conversation or the page beside it, which takes the
                // keyboard only until it leaves.
                const target = Array.from(
                  document.querySelectorAll<HTMLElement>('#session-main, .workspace-page'),
                ).find((each) => each.getClientRects().length > 0);
                if (!target) return document.getElementById('main-content')?.focus();
                target.tabIndex = -1;
                target.addEventListener('blur', () => target.removeAttribute('tabindex'), {
                  once: true,
                });
                target.focus();
              }}
            >
              Skip to content
            </a>
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
            <SettingsDialog
              section={settingsShown}
              onSection={setSettingsShown}
              onClose={() => setSettingsShown(undefined)}
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
    </SettingsControl.Provider>
  );
}
