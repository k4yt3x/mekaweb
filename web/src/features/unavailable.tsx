import { LogOut, RefreshCw } from 'lucide-react';
import { useConnection, useRuntime } from '../connections/context';
import { useAction } from '../components/actions';
import { Button } from '../components/ui/button';
import { ErrorNotice, Loading } from '../components/common';
import { MekaStudioLink } from '../components/layout';

/** What a signed-in page shows while Meka cannot be reached: why, and ways to try again. */
export function Unavailable() {
  const runtime = useRuntime();
  const state = useConnection();
  const action = useAction();
  return (
    <main className="welcome unavailable">
      <section className="connection-card" aria-label="Meka is unavailable">
        <h1>Meka Studio</h1>
        {state.busy ? (
          <Loading label="Connecting to Meka…" />
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
        <MekaStudioLink /> version {__MEKA_STUDIO_VERSION__}
      </footer>
    </main>
  );
}
