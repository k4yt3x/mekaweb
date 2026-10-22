import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, Pencil, Plus, Smartphone } from 'lucide-react';
import { useConnection, useGateway, useRuntime } from '../connections/context';
import { useAction } from '../components/actions';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { ConfirmButton, ErrorNotice, Field, Loading, Timestamp } from '../components/common';
import { isProblem, type Gateway } from '../api/gateway';
import { PasskeyError, createPasskey, isPasskeySupported } from '../auth/webauthn';
import { useConfirmed } from './confirm';

/** The account: who is signed in, passkeys, the password, devices and the sign-in log. */
export function AccountSettings() {
  return (
    <>
      <AccountPanel />
      <PasskeysPanel />
      <PasswordPanel />
      <DevicesPanel />
      <SignInLogPanel />
    </>
  );
}

function useInvalidate() {
  const queries = useQueryClient();
  return (path: string) =>
    queries.invalidateQueries({
      queryKey: ['gateway'],
      predicate: (query) => query.queryKey.includes(path),
    });
}

function AccountPanel() {
  const runtime = useRuntime();
  const { account } = useConnection();
  const action = useAction();
  return (
    <section className="panel account-panel" id="account" tabIndex={-1}>
      <h2>Account</h2>
      <dl className="facts">
        <dt>Signed in as</dt>
        <dd>{account?.username}</dd>
        <dt>This device</dt>
        <dd>{account?.device_name}</dd>
      </dl>
      <ErrorNotice error={action.error} />
      <div className="panel-footer">
        <Button
          variant="secondary"
          disabled={action.busy}
          onClick={() => void action.run(() => runtime.signOut())}
        >
          <LogOut size={16} />
          Sign out
        </Button>
      </div>
    </section>
  );
}

function PasskeysPanel() {
  const runtime = useRuntime();
  const { account } = useConnection();
  const passkeys = useGateway<Gateway['PasskeyView'][]>('/api/account/passkeys');
  const invalidate = useInvalidate();
  const confirmed = useConfirmed();
  const action = useAction();
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<Gateway['PasskeyView']>();
  const available = Boolean(account?.passkeys_available) && isPasskeySupported();
  async function add(event: FormEvent) {
    event.preventDefault();
    await action.run(() =>
      confirmed.run(async () => {
        const challenge = await runtime.gateway.send<Gateway['PasskeyChallenge']>(
          'POST',
          '/api/account/passkeys/challenge',
        );
        const credential = await createPasskey(challenge.options as Record<string, unknown>);
        await runtime.gateway.send('POST', '/api/account/passkeys', {
          challenge: challenge.id,
          credential,
          name: name.trim() || account?.device_name || 'Passkey',
        });
        setAdding(false);
        setName('');
        await runtime.refreshAccount();
        await invalidate('/api/account/passkeys');
      }),
    );
  }
  return (
    <section className="panel">
      <h2>Passkeys</h2>
      <p className="muted small">
        {available
          ? 'Sign in with Face ID, Touch ID, Windows Hello or a security key.'
          : 'Passkeys need HTTPS and a hostname.'}
      </p>
      <ErrorNotice error={passkeys.error} />
      {passkeys.isPending && <Loading />}
      <div className="bounded">
        {passkeys.data?.map((passkey) => (
          <div className="setting-row connection-row" key={passkey.id}>
            <div className="connection-details">
              <strong>{passkey.name}</strong>
              <p className="muted small">
                Added <Timestamp value={passkey.created_at} />
                {' · '}
                {passkey.last_used_at ? (
                  <>
                    last used <Timestamp value={passkey.last_used_at} />
                  </>
                ) : (
                  'never used'
                )}
              </p>
            </div>
            <div className="actions wrap">
              <Button variant="ghost" onClick={() => setRenaming(passkey)}>
                <Pencil size={14} />
                Rename
              </Button>
              <ConfirmButton
                title="Remove passkey"
                description={`Remove “${passkey.name}”? It will no longer sign in to mekaweb. The authenticator keeps its copy until you delete it there.`}
                onConfirm={() =>
                  confirmed.run(async () => {
                    await runtime.gateway.send(
                      'DELETE',
                      `/api/account/passkeys/${encodeURIComponent(passkey.id)}`,
                    );
                    await runtime.refreshAccount();
                    await invalidate('/api/account/passkeys');
                  }) as Promise<unknown>
                }
              >
                Remove
              </ConfirmButton>
            </div>
          </div>
        ))}
      </div>
      {passkeys.data?.length === 0 && <p className="muted small">No passkeys yet.</p>}
      <ErrorNotice
        error={
          action.error instanceof PasskeyError && action.error.kind === 'aborted'
            ? undefined
            : action.error
        }
      />
      <div className="panel-footer">
        <Button disabled={!available || action.busy} onClick={() => setAdding(true)}>
          <Plus size={16} />
          Add a passkey
        </Button>
      </div>
      <Dialog open={adding} onOpenChange={setAdding} title="Add a passkey">
        <form className="form-stack" onSubmit={(event) => void add(event)}>
          <Field label="Name" hint="Such as the device that holds it.">
            <input
              value={name}
              placeholder={account?.device_name}
              onChange={(event) => setName(event.target.value)}
              maxLength={60}
            />
          </Field>
          <ErrorNotice error={action.error} />
          <div className="actions">
            <Button type="submit" disabled={action.busy}>
              <KeyRound size={16} />
              Create passkey
            </Button>
          </div>
        </form>
      </Dialog>
      <RenameDialog
        title="Rename passkey"
        current={renaming?.name}
        onClose={() => setRenaming(undefined)}
        onSave={async (value) => {
          if (!renaming) return;
          await runtime.gateway.send(
            'PATCH',
            `/api/account/passkeys/${encodeURIComponent(renaming.id)}`,
            {
              name: value,
            },
          );
          await invalidate('/api/account/passkeys');
        }}
      />
      {confirmed.dialog}
    </section>
  );
}

/** What is wrong with `password` as `username`'s, by the rules mekaweb applies. */
function passwordProblem(password: string, username: string | undefined) {
  const length = [...password].length;
  if (length < 10) return 'At least 10 characters.';
  if (length > 128) return 'At most 128 characters.';
  if (username && password.toLowerCase() === username.toLowerCase())
    return 'Cannot be the username.';
  return undefined;
}

function PasswordPanel() {
  const runtime = useRuntime();
  const { account } = useConnection();
  const queries = useQueryClient();
  const action = useAction();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  // A field is checked once it is left or the form is sent, and then again as it changes.
  const [checked, setChecked] = useState({ current: false, password: false, again: false });
  // How many other devices changing the password signed out, once it is changed.
  const [done, setDone] = useState<number>();
  const wrong = isProblem(action.error, 'wrong-password');
  const problems = {
    current: !current
      ? 'Enter the current password.'
      : wrong
        ? 'The password is wrong.'
        : undefined,
    password: passwordProblem(password, account?.username),
    again: again === password ? undefined : 'Does not match the new password.',
  };
  const shown = (field: keyof typeof problems) => (checked[field] ? problems[field] : undefined);
  const leave = (field: keyof typeof problems, value: string) => {
    if (value) setChecked((previous) => ({ ...previous, [field]: true }));
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDone(undefined);
    setChecked({ current: true, password: true, again: true });
    const first = (['current', 'password', 'again'] as const).find((field) =>
      field === 'current' ? !current : problems[field],
    );
    if (first) {
      event.currentTarget.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus();
      return;
    }
    await action.run(async () => {
      const out = await runtime.gateway.send<Gateway['SignedOut']>('PUT', '/api/account/password', {
        current,
        password,
      });
      setCurrent('');
      setPassword('');
      setAgain('');
      setChecked({ current: false, password: false, again: false });
      setDone(out.count);
      void queries.invalidateQueries({ queryKey: ['gateway'] });
    });
  }
  return (
    <section className="panel">
      <h2>Password</h2>
      <form
        className="form-stack password-form"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <Field label="Current password" error={shown('current')}>
          <input
            name="current"
            type="password"
            value={current}
            onChange={(event) => {
              setCurrent(event.target.value);
              if (wrong) action.reset();
            }}
            onBlur={(event) => leave('current', event.target.value)}
            autoComplete="current-password"
          />
        </Field>
        <Field label="New password" error={shown('password')}>
          <input
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onBlur={(event) => leave('password', event.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <Field label="Confirm new password" error={shown('again')}>
          <input
            name="again"
            type="password"
            value={again}
            onChange={(event) => setAgain(event.target.value)}
            onBlur={(event) => leave('again', event.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <ErrorNotice error={wrong ? undefined : action.error} />
        {done !== undefined && (
          <p className="muted small" role="status">
            Password changed.{' '}
            {done === 0
              ? ''
              : done === 1
                ? 'The other device is signed out.'
                : `${done} other devices are signed out.`}
          </p>
        )}
        <div className="actions">
          <Button type="submit" variant="secondary" disabled={action.busy}>
            Change password
          </Button>
        </div>
      </form>
    </section>
  );
}

function DevicesPanel() {
  const runtime = useRuntime();
  const devices = useGateway<Gateway['DeviceView'][]>('/api/account/devices');
  const invalidate = useInvalidate();
  const [renaming, setRenaming] = useState<Gateway['DeviceView']>();
  const action = useAction();
  return (
    <section className="panel">
      <h2>Devices</h2>
      <p className="muted small">Signing a device out also stops its push notifications.</p>
      <ErrorNotice error={devices.error ?? action.error} />
      {devices.isPending && <Loading />}
      <div className="bounded">
        {devices.data?.map((device) => (
          <div className="setting-row connection-row" key={device.id}>
            <div className="connection-details">
              <strong className="row-title">
                <Smartphone size={14} aria-hidden="true" /> {device.name}
                {device.current && <span className="badge">This device</span>}
                {device.push && <span className="badge">Push</span>}
              </strong>
              <p
                className="muted small"
                title={`Last seen ${new Date(device.last_seen_at).toLocaleString()} · signed in ${new Date(device.created_at).toLocaleString()} with a ${device.method}`}
              >
                {device.device} · {device.current ? 'Active now' : seen(device.last_seen_at)} ·{' '}
                {device.last_ip}
              </p>
            </div>
            <div className="actions wrap">
              <Button variant="ghost" onClick={() => setRenaming(device)}>
                <Pencil size={14} />
                Rename
              </Button>
              {device.current ? (
                <Button
                  variant="ghost"
                  tone="danger"
                  disabled={action.busy}
                  onClick={() => void action.run(() => runtime.signOut())}
                >
                  Sign out
                </Button>
              ) : (
                <ConfirmButton
                  title="Sign out device"
                  description={`Sign out ${device.name}? It will need to sign in again.`}
                  onConfirm={async () => {
                    await runtime.gateway.send(
                      'DELETE',
                      `/api/account/devices/${encodeURIComponent(device.id)}`,
                    );
                    await invalidate('/api/account/devices');
                  }}
                >
                  Sign out
                </ConfirmButton>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="panel-footer">
        <ConfirmButton
          title="Sign out other devices"
          description="Sign out every device but this one. They will need to sign in again."
          disabled={(devices.data?.length ?? 0) < 2}
          onConfirm={async () => {
            await runtime.gateway.send('POST', '/api/account/devices/sign-out-others');
            await invalidate('/api/account/devices');
          }}
        >
          Sign out other devices
        </ConfirmButton>
      </div>
      <RenameDialog
        title="Rename device"
        current={renaming ? (renaming.named ? renaming.name : '') : undefined}
        placeholder={renaming?.name}
        onClose={() => setRenaming(undefined)}
        onSave={async (value) => {
          if (!renaming) return;
          await runtime.gateway.send(
            'PATCH',
            `/api/account/devices/${encodeURIComponent(renaming.id)}`,
            {
              name: value,
            },
          );
          await invalidate('/api/account/devices');
          if (renaming.current) await runtime.refreshAccount();
        }}
      />
    </section>
  );
}

function SignInLogPanel() {
  const [open, setOpen] = useState(false);
  const log = useGateway<Gateway['LogEntryView'][]>('/api/account/log', undefined, open);
  return (
    <section className="panel">
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <h2 className="inline-heading">Sign-in activity</h2>
        </summary>
        <ErrorNotice error={log.error} />
        {open && log.isPending && <Loading />}
        <div className="log-table bounded" role="table" aria-label="Sign-in activity" tabIndex={0}>
          {log.data?.map((entry, index) => (
            <div role="row" className="log-row" key={index} data-outcome={entry.outcome}>
              <span role="cell">
                <Timestamp value={entry.at} />
              </span>
              <span role="cell">{outcomeText(entry.outcome)}</span>
              <span role="cell">{methodText(entry.method)}</span>
              <span role="cell" className="muted">
                {entry.device} · {entry.ip}
              </span>
            </div>
          ))}
        </div>
        {log.data?.length === 0 && <p className="muted small">No sign-ins yet.</p>}
      </details>
    </section>
  );
}

/** When a device was last seen, as a person says it: "Active now", "3 hours ago". */
function seen(value: string) {
  const minutes = (Date.now() - Date.parse(value)) / 60_000;
  if (!Number.isFinite(minutes)) return 'Not seen';
  if (minutes < 2) return 'Active now';
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (minutes < 60) return relative.format(-Math.round(minutes), 'minute');
  if (minutes < 24 * 60) return relative.format(-Math.round(minutes / 60), 'hour');
  if (minutes < 7 * 24 * 60) return relative.format(-Math.round(minutes / (24 * 60)), 'day');
  return new Date(value).toLocaleDateString();
}

function outcomeText(outcome: string) {
  return (
    {
      'signed-in': 'Signed in',
      confirmed: 'Confirmed',
      wrong: 'Wrong password',
      refused: 'Passkey refused',
    }[outcome] ?? outcome
  );
}

function methodText(method: string) {
  return (
    {
      password: 'password',
      passkey: 'passkey',
      'confirm-password': 'password check',
      'confirm-passkey': 'passkey check',
      'change-password': 'password change',
    }[method] ?? method
  );
}

function RenameDialog({
  title,
  current,
  placeholder,
  onClose,
  onSave,
}: {
  title: string;
  current: string | undefined;
  placeholder?: string | undefined;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState<string>();
  const action = useAction();
  const value = name ?? current ?? '';
  return (
    <Dialog
      open={current !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          setName(undefined);
          action.reset();
          onClose();
        }
      }}
      title={title}
    >
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            await onSave(value.trim());
            setName(undefined);
            action.reset();
            onClose();
          });
        }}
      >
        <Field label="Name">
          <input
            value={value}
            placeholder={placeholder}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
          />
        </Field>
        <ErrorNotice error={action.error} />
        <div className="actions">
          <Button type="submit" disabled={action.busy}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
