import { LogOut, UserRound } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { useConnection, useRuntime } from '../connections/context';
import { useAction } from './actions';
import { ErrorNotice } from './common';

/**
 * Who is signed in, at the foot of the navigation: the name opens the account's settings, and the
 * square beside it signs out.
 */
export function AccountMenu({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const state = useConnection();
  const runtime = useRuntime();
  const navigate = useNavigate();
  const signingOut = useAction();
  const account = state.account;
  if (!account) return null;
  const status =
    state.connectionIssue === 'offline'
      ? 'Offline'
      : state.connectionIssue === 'checking'
        ? 'Reconnecting'
        : 'Connected';
  return (
    <>
      <ErrorNotice error={signingOut.error} />
      <div className="account-bar" data-status={state.connectionIssue ?? 'connected'}>
        <a
          href="#/settings"
          className="account-link"
          aria-label={`Account settings for ${account.username} on ${account.device_name}, ${status.toLowerCase()}`}
          title={`${account.username} · ${account.device_name} · ${status}`}
          onClick={(event) => {
            event.preventDefault();
            onNavigate?.();
            // Settings opens at its account section, which leads it; scrolled away, it comes back.
            void navigate({ to: '/settings' }).then(() =>
              requestAnimationFrame(() => {
                const section = document.getElementById('account');
                section?.scrollIntoView({ block: 'start' });
                section?.focus({ preventScroll: true });
              }),
            );
          }}
        >
          <UserRound size={18} aria-hidden="true" />
          <span className="account-name">{account.username}</span>
        </a>
        <button
          type="button"
          className="account-sign-out"
          aria-label="Sign out"
          title="Sign out"
          disabled={signingOut.busy}
          onClick={() => void signingOut.run(() => runtime.signOut())}
        >
          <LogOut size={16} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
