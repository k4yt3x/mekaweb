import type { ReactNode } from 'react';
import { LogOut, Settings, UserRound } from 'lucide-react';
import { useConnection, useRuntime } from '../connections/context';
import { useAction } from './actions';
import { ErrorNotice } from './common';
import { useOpenSettings } from './settings-control';

/**
 * Who is signed in, at the foot of the sidebar: the name opens the account's part of Settings,
 * and the buttons after it open Settings and sign out, with `children` before them.
 */
export function AccountMenu({ children }: { children?: ReactNode }) {
  const state = useConnection();
  const runtime = useRuntime();
  const openSettings = useOpenSettings();
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
            openSettings('account');
          }}
        >
          <UserRound size={18} aria-hidden="true" />
          <span className="account-name">{account.username}</span>
        </a>
        {children}
        <button
          type="button"
          className="account-action"
          aria-label="Settings"
          title="Settings"
          onClick={() => openSettings()}
        >
          <Settings size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="account-action account-sign-out"
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
