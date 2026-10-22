import { LogOut, RefreshCw } from 'lucide-react';
import { useConnection, useRuntime } from '../connections/context';
import { useAction } from '../components/actions';
import { Button } from '../components/ui/button';
import { ErrorNotice, Loading } from '../components/common';
import { MekawebLink } from '../components/layout';

/** What a signed-in page shows while meka cannot be reached: why, and ways to try again. */
export function Unavailable() {
  const runtime = useRuntime();
  const state = useConnection();
  const action = useAction();
  return (
    <main className="welcome unavailable">
      <section className="connection-card" aria-label="meka is unavailable">
        <h1>meka</h1>
        {state.busy ? (
          <Loading label="Connecting to meka…" />
        ) : (
          <>
            <ErrorNotice error={state.error ? new Error(state.error) : undefined} />
            <div className="connection-actions">
              <Button disabled={state.busy} onClick={() => void runtime.reconnect()}>
                <RefreshCw size={16} />
                Try again
              </Button>
              <Button
                variant="secondary"
                disabled={action.busy}
                onClick={() => void action.run(() => runtime.signOut())}
              >
                <LogOut size={16} />
                Sign out
              </Button>
            </div>
            <ErrorNotice error={action.error} />
          </>
        )}
      </section>
      <footer className="app-version">
        <MekawebLink /> version {__MEKAWEB_VERSION__}
      </footer>
    </main>
  );
}
