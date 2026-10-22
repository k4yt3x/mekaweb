import { useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound } from 'lucide-react';
import { useConnection, useRuntime } from '../connections/context';
import { useAction } from '../components/actions';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { ErrorNotice, Field } from '../components/common';
import type { Gateway } from '../api/gateway';
import { getPasskey } from '../auth/webauthn';

/** Asks the person to confirm who they are: with a passkey where they have one, else a password. */
export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirmed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmed: () => Promise<void>;
}) {
  const runtime = useRuntime();
  const { account } = useConnection();
  const [password, setPassword] = useState('');
  const action = useAction();
  const passkey = Boolean(account?.has_passkeys && account.passkeys_available);
  async function confirm(body: Record<string, unknown>) {
    await runtime.gateway.send('POST', '/api/auth/confirm', body);
    await runtime.refreshAccount();
    setPassword('');
    await onConfirmed();
  }
  async function withPasskey() {
    const challenge = await runtime.gateway.send<Gateway['PasskeyChallenge']>(
      'POST',
      '/api/auth/confirm/challenge',
    );
    const credential = await getPasskey(challenge.options as Record<string, unknown>);
    await confirm({ challenge: challenge.id, credential });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void action.run(() => confirm({ password }));
  }
  let body: ReactNode;
  if (passkey)
    body = (
      <div className="actions">
        <Button disabled={action.busy} onClick={() => void action.run(withPasskey)}>
          <KeyRound size={16} />
          Use a passkey
        </Button>
      </div>
    );
  else
    body = (
      <form className="form-stack" onSubmit={submit}>
        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <div className="actions">
          <Button type="submit" disabled={action.busy || !password}>
            Confirm
          </Button>
        </div>
      </form>
    );
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!action.busy) onOpenChange(value);
      }}
      title="Confirm it’s you"
      description={
        passkey
          ? 'This needs a recent check with one of your passkeys.'
          : 'This needs a recent check of your password.'
      }
    >
      {body}
      <ErrorNotice error={action.error} />
    </Dialog>
  );
}
