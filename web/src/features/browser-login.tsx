import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import { useAction } from '../components/actions';
import { useConnection, useResource } from '../connections/context';
import type { Schema } from '../api/client';
import { Button } from '../components/ui/button';
import { ErrorNotice, Field } from '../components/common';

/**
 * A browser sign-in meka began: the page to open, then what the page gives pasted back. Where
 * meka holds the redirect's loopback port itself, a browser on its own machine needs no paste, so
 * the login's state is watched too.
 */
export function BrowserLogin({
  started,
  path,
  onDone,
  onRestart,
}: {
  started: Schema['LoginStarted'];
  /** The login's own route, `…/login/{login_id}`, which says where it stands and takes the paste. */
  path: string;
  onDone: () => Promise<void>;
  onRestart: () => void;
}) {
  const { api } = useConnection();
  const action = useAction();
  const [code, setCode] = useState('');
  const status = useResource<Schema['LoginStatus']>(path, undefined, started.listening, 2000);
  const state = status.data?.status;
  // Completed once, whether the paste or meka's own listener got there first.
  const finished = useRef(false);
  useEffect(() => {
    if (state !== 'completed' || finished.current) return;
    finished.current = true;
    void onDone();
  }, [state, onDone]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!api) return;
      await api.mutate('POST', path, {
        code: code.trim(),
      } satisfies Schema['CompleteLoginRequest']);
      finished.current = true;
      await onDone();
    });
  }
  const pasteUrl = started.completes_with === 'callback_url';
  if (state === 'failed')
    return (
      <div className="form-stack">
        <ErrorNotice error={new Error(status.data?.error ?? 'The sign-in did not complete.')} />
        <div className="actions">
          <Button onClick={onRestart}>Start again</Button>
        </div>
      </div>
    );
  return (
    <form className="form-stack" onSubmit={(event) => void submit(event)}>
      <p className="muted small">
        {pasteUrl
          ? 'Sign in on the page. It then sends your browser to a localhost address that may not load; paste that address here.'
          : 'Sign in on the page, then paste the code it shows.'}
        {pasteUrl && started.listening && ' On meka’s own machine, this finishes by itself.'}
      </p>
      <div>
        <a
          className="button button-secondary"
          href={started.authorization_url}
          target="_blank"
          rel="noreferrer noopener"
        >
          <ExternalLink size={16} />
          Open sign-in page
        </a>
      </div>
      <Field
        label={pasteUrl ? 'Address' : 'Code'}
        hint={`Expires at ${new Date(started.expires_at).toLocaleTimeString()}.`}
      >
        <input
          required
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </Field>
      <ErrorNotice error={action.error} />
      <div className="actions">
        <Button type="submit" disabled={action.busy}>
          {action.busy ? 'Signing in…' : 'Finish sign-in'}
        </Button>
      </div>
    </form>
  );
}
