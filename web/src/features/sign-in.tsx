import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, KeyRound } from 'lucide-react';
import { useConnection, useRuntime } from '../connections/context';
import { useAction } from '../components/actions';
import { Button } from '../components/ui/button';
import { ErrorNotice, Field, Loading } from '../components/common';
import { MekawebLink } from '../components/layout';
import { isProblem, type Gateway } from '../api/gateway';
import {
  PasskeyError,
  getPasskey,
  isConditionalSupported,
  isPasskeySupported,
} from '../auth/webauthn';

/** The sign-in page: a password, or a passkey where this address offers them. */
export function SignIn() {
  const runtime = useRuntime();
  const state = useConnection();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passkeys, setPasskeys] = useState(isPasskeySupported());
  const action = useAction();
  async function signInWithPasskey(conditional: boolean, signal?: AbortSignal) {
    let challenge: Gateway['PasskeyChallenge'];
    try {
      challenge = await runtime.gateway.send<Gateway['PasskeyChallenge']>(
        'POST',
        '/api/auth/passkey/challenge',
      );
    } catch (error) {
      // Passkeys need a name over HTTPS, or localhost; elsewhere the password is all there is.
      if (isProblem(error, 'passkeys-unavailable')) {
        setPasskeys(false);
        return;
      }
      throw error;
    }
    const credential = await getPasskey(challenge.options as Record<string, unknown>, {
      conditional,
      ...(signal ? { signal } : {}),
    });
    const account = await runtime.gateway.send<Gateway['SessionView']>(
      'POST',
      '/api/auth/passkey',
      {
        challenge: challenge.id,
        credential,
      },
    );
    await runtime.signedIn(account);
  }
  // Offers the site's passkeys as the username field is used, where the browser can.
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      if (!(await isConditionalSupported()) || abort.signal.aborted) return;
      try {
        await signInWithPasskey(true, abort.signal);
      } catch (error) {
        if (error instanceof PasskeyError) return;
        if (!abort.signal.aborted) action.setError(error);
      }
    })();
    return () => abort.abort();
    // The quiet request starts once; a passkey sign-in by button replaces it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      const account = await runtime.gateway.send<Gateway['SessionView']>(
        'POST',
        '/api/auth/password',
        { username: username.trim(), password },
      );
      setPassword('');
      await runtime.signedIn(account);
    });
  }
  return (
    <main className="welcome">
      <section className="connection-card" aria-label="Sign in to mekaweb">
        <h1>meka</h1>
        {state.notice && (
          <p className="muted" role="status">
            {state.notice}
          </p>
        )}
        <form onSubmit={(event) => void submit(event)} className="form-stack">
          <Field label="Username">
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username webauthn"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <ErrorNotice
            error={
              action.error instanceof PasskeyError && action.error.kind === 'aborted'
                ? undefined
                : action.error
            }
          />
          <div className="connection-actions">
            <Button type="submit" disabled={action.busy || state.busy}>
              {action.busy || state.busy ? (
                <Loading label="Signing in…" />
              ) : (
                <>
                  Sign in <ArrowRight size={16} />
                </>
              )}
            </Button>
            {passkeys && (
              <Button
                type="button"
                variant="secondary"
                disabled={action.busy || state.busy}
                onClick={() => void action.run(() => signInWithPasskey(false))}
              >
                <KeyRound size={16} />
                Use a passkey
              </Button>
            )}
          </div>
        </form>
      </section>
      <footer className="app-version">
        <MekawebLink /> version {__MEKAWEB_VERSION__}
      </footer>
    </main>
  );
}
