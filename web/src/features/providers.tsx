import { useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { KeyRound, LogIn, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useAction } from '../components/actions';
import { useCan, useConnection, useResource, useRuntime } from '../connections/context';
import { segment, type Schema } from '../api/client';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { SwitchField } from '../components/ui/switch';
import { ConfirmButton, ErrorNotice, Field, Loading } from '../components/common';
import { BrowserLogin } from './browser-login';
import {
  BACKENDS,
  backendLabel,
  createAccountBody,
  createProfileBody,
  isSubscription,
  patchProfileBody,
  profileDraft,
  readsAccountKey,
  readsProfileKey,
  type AccountDraft,
  type ProfileDraft,
} from './providers-model';

/** meka's accounts, which hold what a provider signs in with, and the profiles that run on them. */
export function ProvidersPage() {
  const canRead = useCan('config:r');
  const profiles = useResource<Schema['ProfilesResponse']>('/v1/profiles');
  const accounts = useResource<Schema['AccountsResponse']>('/v1/accounts', undefined, canRead);
  return (
    <div className="page settings-page">
      <header className="page-heading">
        <h1>Providers</h1>
      </header>
      <ProfilesPanel profiles={profiles} accounts={accounts.data?.accounts} />
      <AccountsPanel accounts={accounts} />
    </div>
  );
}

function ProfilesPanel({
  profiles,
  accounts,
}: {
  profiles: ReturnType<typeof useResource<Schema['ProfilesResponse']>>;
  accounts: Schema['AccountView'][] | undefined;
}) {
  const { api } = useConnection();
  const runtime = useRuntime();
  const canRead = useCan('config:r');
  const canWrite = useCan('config:w');
  const [editing, setEditing] = useState<string>();
  const [creating, setCreating] = useState(false);
  const all = profiles.data?.profiles ?? [];
  const requires = !canWrite ? 'Requires config:w' : !canRead ? 'Requires config:r' : undefined;
  return (
    <section className="panel">
      <h2>Profiles</h2>
      <ErrorNotice error={profiles.error} />
      {profiles.isPending && <Loading />}
      <div className="bounded">
        {all.map((profile) => (
          <div className="setting-row connection-row" key={profile.name}>
            <div className="connection-details">
              <strong>
                {profile.name}
                {profile.active && <span className="badge">Default</span>}
              </strong>
              <p className="muted small">
                {profile.model ?? 'No model'} · {profile.account} · {backendLabel(profile.backend)}
                {!profile.vision && ' · No images'}
                {profile.fallbacks?.length
                  ? ` · Falls back to ${profile.fallbacks.join(', ')}`
                  : ''}
              </p>
            </div>
            <div className="actions wrap">
              <Button
                variant="ghost"
                disabled={Boolean(requires)}
                title={requires}
                onClick={() => setEditing(profile.name)}
              >
                <Pencil size={14} />
                Edit
              </Button>
              <ConfirmButton
                disabled={!canWrite}
                title="Remove profile"
                description={`Remove “${profile.name}”? Sessions on it can’t resume until they move to another profile.`}
                onConfirm={async () => {
                  await api?.mutate('DELETE', `/v1/profiles/${segment(profile.name)}`);
                  await runtime.queries.invalidateQueries();
                }}
              >
                <Trash2 size={14} />
                Remove
              </ConfirmButton>
            </div>
          </div>
        ))}
      </div>
      {profiles.data && !all.length && (
        <p className="muted small">
          No profiles yet. A profile picks an account and a model; sessions run on one.
        </p>
      )}
      <div className="panel-footer">
        <Button
          disabled={!canWrite || accounts?.length === 0}
          title={
            !canWrite
              ? 'Requires config:w'
              : accounts?.length === 0
                ? 'Add an account first'
                : undefined
          }
          onClick={() => setCreating(true)}
        >
          <Plus size={16} />
          New profile
        </Button>
      </div>
      <Dialog open={creating} onOpenChange={setCreating} title="New profile" wide>
        {creating && (
          <ProfileForm
            profiles={all}
            accounts={accounts}
            onSaved={async () => {
              await runtime.queries.invalidateQueries();
              setCreating(false);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
        title={`Edit ${editing ?? 'profile'}`}
        wide
      >
        {editing !== undefined && (
          <EditProfile
            name={editing}
            profiles={all}
            accounts={accounts}
            onSaved={async () => {
              // Closed first, so a renamed profile's old entry is not read again.
              flushSync(() => setEditing(undefined));
              await runtime.queries.invalidateQueries();
            }}
          />
        )}
      </Dialog>
    </section>
  );
}

function EditProfile({
  name,
  ...props
}: {
  name: string;
  profiles: Schema['ProfileView'][];
  accounts: Schema['AccountView'][] | undefined;
  onSaved: () => Promise<void>;
}) {
  const detail = useResource<Schema['ProfileDetailView']>(
    `/v1/profiles/${segment(name)}`,
    undefined,
    true,
    false,
  );
  if (detail.error) return <ErrorNotice error={detail.error} />;
  if (!detail.data) return <Loading />;
  return <ProfileForm initial={detail.data} {...props} />;
}

const optionLabels: Record<string, string> = {
  '': 'Default',
  true: 'On',
  false: 'Off',
};

function ProfileForm({
  initial,
  profiles,
  accounts,
  onSaved,
}: {
  initial?: Schema['ProfileDetailView'];
  profiles: Schema['ProfileView'][];
  accounts: Schema['AccountView'][] | undefined;
  onSaved: () => Promise<void>;
}) {
  const { api } = useConnection();
  const action = useAction();
  const [start] = useState(() => profileDraft(initial));
  const [draft, setDraft] = useState(() => ({
    ...start,
    account: start.account || accounts?.[0]?.name || '',
  }));
  const backend = initial
    ? initial.backend
    : accounts?.find((account) => account.name === draft.account)?.backend;
  const set = (patch: Partial<ProfileDraft>) => setDraft((old) => ({ ...old, ...patch }));
  const reads = (key: string) => readsProfileKey(backend, key);
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!api) return;
      if (!initial) {
        await api.mutate('POST', '/v1/profiles', createProfileBody(draft, backend));
      } else {
        const path = `/v1/profiles/${segment(initial.name)}`;
        const patch = patchProfileBody(start, draft, backend);
        if (Object.keys(patch).length) await api.mutate('PATCH', path, patch);
        // meka takes a rename on its own, after the settings it moves with.
        if (draft.name.trim() !== initial.name)
          await api.mutate('PATCH', path, {
            name: draft.name.trim(),
          } satisfies Schema['PatchProfileRequest']);
      }
      await onSaved();
    });
  }
  const others = profiles.filter(
    (profile) => profile.name !== initial?.name && !draft.fallbacks.includes(profile.name),
  );
  const tristate = (
    key: 'vision' | 'cache_control' | 'encrypted_reasoning' | 'reasoning_summary',
    label: string,
    hint?: string,
  ) => (
    <Field label={label} hint={hint}>
      <select value={draft[key]} onChange={(event) => set({ [key]: event.target.value })}>
        {['', 'true', 'false'].map((value) => (
          <option key={value} value={value}>
            {optionLabels[value]}
          </option>
        ))}
      </select>
    </Field>
  );
  const count = (
    key: 'context_window' | 'max_output_tokens' | 'max_request_bytes' | 'thinking_budget',
    label: string,
  ) => (
    <Field label={label}>
      <input
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        placeholder="Default"
        value={draft[key]}
        onChange={(event) => set({ [key]: event.target.value })}
      />
    </Field>
  );
  const choice = (
    key: 'deferred_tools' | 'thinking' | 'thinking_display',
    label: string,
    values: string[],
  ) => (
    <Field label={label}>
      <select value={draft[key]} onChange={(event) => set({ [key]: event.target.value })}>
        <option value="">Default</option>
        {values.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <form onSubmit={(event) => void submit(event)}>
      <fieldset className="form-stack" disabled={action.busy}>
        <div className="form-grid">
          <Field label="Name">
            <input
              required
              value={draft.name}
              onChange={(event) => set({ name: event.target.value })}
              placeholder="work"
            />
          </Field>
          <Field label="Account" hint={initial ? 'Another account is another profile.' : undefined}>
            {accounts && !initial ? (
              <select
                required
                value={draft.account}
                onChange={(event) => set({ account: event.target.value })}
              >
                {accounts.map((account) => (
                  <option key={account.name} value={account.name}>
                    {account.name} · {backendLabel(account.backend)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                required
                disabled={Boolean(initial)}
                value={draft.account}
                onChange={(event) => set({ account: event.target.value })}
              />
            )}
          </Field>
          <Field label="Model" hint="Sent to the provider as written.">
            <input
              required
              spellCheck={false}
              value={draft.model}
              onChange={(event) => set({ model: event.target.value })}
              placeholder={
                backend?.startsWith('openai') || backend === 'chatgpt-subscription'
                  ? 'gpt-6-astra'
                  : 'claude-opus-5-5'
              }
            />
          </Field>
        </div>
        {(draft.fallbacks.length > 0 || others.length > 0) && (
          <Field label="Fallbacks" hint="Profiles that serve a turn this one can’t, in order.">
            <div className="fallback-list">
              {draft.fallbacks.map((name) => (
                <span className="tag" key={name}>
                  {name}
                  <button
                    type="button"
                    className="tag-remove"
                    aria-label={`Remove ${name}`}
                    onClick={() => set({ fallbacks: draft.fallbacks.filter((f) => f !== name) })}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
              {others.length > 0 && (
                <select
                  aria-label="Add a fallback"
                  value=""
                  onChange={(event) => set({ fallbacks: [...draft.fallbacks, event.target.value] })}
                >
                  <option value="">Add a fallback…</option>
                  {others.map((profile) => (
                    <option key={profile.name} value={profile.name}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </Field>
        )}
        <details>
          <summary>Advanced</summary>
          <div className="form-grid">
            {count('context_window', 'Context window')}
            {count('max_output_tokens', 'Max output tokens')}
            {count('max_request_bytes', 'Max request bytes')}
            <Field label="Effort">
              <input
                list="profile-effort"
                placeholder="Default"
                value={draft.effort}
                onChange={(event) => set({ effort: event.target.value })}
              />
            </Field>
            {tristate('vision', 'Images')}
            {reads('deferred_tools') &&
              choice('deferred_tools', 'Deferred tools', ['native', 'append'])}
            {reads('thinking') && choice('thinking', 'Thinking', ['adaptive', 'budgeted', 'off'])}
            {reads('thinking_budget') &&
              (draft.thinking === 'budgeted' || draft.thinking_budget) &&
              count('thinking_budget', 'Thinking budget')}
            {reads('thinking_display') &&
              choice('thinking_display', 'Thinking display', ['summarized', 'updates', 'redacted'])}
            {reads('cache_control') && tristate('cache_control', 'Cache breakpoint')}
            {reads('encrypted_reasoning') && tristate('encrypted_reasoning', 'Encrypted reasoning')}
            {reads('reasoning_summary') && tristate('reasoning_summary', 'Reasoning summary')}
          </div>
          <datalist id="profile-effort">
            {['low', 'medium', 'high', 'xhigh', 'max'].map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </details>
        <SwitchField
          label="Default profile"
          checked={draft.makeDefault}
          disabled={start.makeDefault}
          title={start.makeDefault ? 'Make another profile the default to change it' : undefined}
          onCheckedChange={(checked) => set({ makeDefault: checked })}
        />
        <ErrorNotice error={action.error} />
        <div className="actions">
          <Button type="submit" disabled={action.busy}>
            {action.busy ? 'Saving…' : initial ? 'Save' : 'Add profile'}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function AccountsPanel({
  accounts,
}: {
  accounts: ReturnType<typeof useResource<Schema['AccountsResponse']>>;
}) {
  const { api } = useConnection();
  const runtime = useRuntime();
  const canRead = useCan('config:r');
  const canWrite = useCan('config:w');
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const [signingIn, setSigningIn] = useState<Schema['AccountView']>();
  const remove = (name: string) => async () => {
    await api?.mutate('DELETE', `/v1/accounts/${segment(name)}`);
    await runtime.queries.invalidateQueries();
  };
  const requires = !canWrite ? 'Requires config:w' : undefined;
  return (
    <section className="panel">
      <h2>Accounts</h2>
      {!canRead && <p className="muted small">Reading accounts requires config:r.</p>}
      <ErrorNotice error={accounts.error} />
      {accounts.isFetching && !accounts.data && <Loading />}
      <div className="bounded">
        {accounts.data?.accounts.map((account) => (
          <div className="setting-row connection-row" key={account.name}>
            <div className="connection-details">
              <strong>
                {account.name}
                {account.authenticated === 'yes' ? (
                  <span className="badge success">Signed in</span>
                ) : account.authenticated === 'unreadable' ? (
                  <span className="badge danger" title="meka can’t read its stored credential">
                    Unreadable
                  </span>
                ) : (
                  <span className="badge">Not signed in</span>
                )}
              </strong>
              <p className="muted small">
                {backendLabel(account.backend)}
                {account.base_url && ` · ${account.base_url}`}
              </p>
            </div>
            <div className="actions wrap">
              <Button
                variant="ghost"
                disabled={!canWrite}
                title={requires}
                onClick={() => setSigningIn(account)}
              >
                {isSubscription(account.backend) ? <LogIn size={14} /> : <KeyRound size={14} />}
                {isSubscription(account.backend) ? 'Sign in' : 'Change key'}
              </Button>
              <Button
                variant="ghost"
                disabled={!canWrite}
                title={requires}
                onClick={() => setRenaming(account.name)}
              >
                <Pencil size={14} />
                Rename
              </Button>
              <ConfirmButton
                disabled={!canWrite}
                title="Remove account"
                description={`Remove “${account.name}” and its stored credential? meka refuses while a profile uses it.`}
                onConfirm={remove(account.name)}
              >
                <Trash2 size={14} />
                Remove
              </ConfirmButton>
            </div>
          </div>
        ))}
        {accounts.data?.orphaned_credentials?.map((name) => (
          <div className="setting-row connection-row" key={`orphan:${name}`}>
            <div className="connection-details">
              <strong>{name}</strong>
              <p className="muted small">A stored credential no account uses.</p>
            </div>
            <div className="actions wrap">
              <ConfirmButton
                disabled={!canWrite}
                title="Remove credential"
                description={`Remove the credential stored as “${name}”?`}
                onConfirm={remove(name)}
              >
                <Trash2 size={14} />
                Remove
              </ConfirmButton>
            </div>
          </div>
        ))}
      </div>
      {accounts.data?.accounts.length === 0 && (
        <p className="muted small">
          No accounts yet. An account is what meka signs in to a provider with.
        </p>
      )}
      <div className="panel-footer">
        <Button disabled={!canWrite} title={requires} onClick={() => setCreating(true)}>
          <Plus size={16} />
          New account
        </Button>
      </div>
      <Dialog open={creating} onOpenChange={setCreating} title="New account">
        {creating && (
          <AccountForm
            onSaved={async (account) => {
              await runtime.queries.invalidateQueries();
              setCreating(false);
              // A subscription is added signed out; its sign-in is the next step.
              if (isSubscription(account.backend)) setSigningIn(account);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={renaming !== undefined}
        onOpenChange={(open) => {
          if (!open) setRenaming(undefined);
        }}
        title="Rename account"
        description="Its profiles and stored credential move with it."
      >
        {renaming !== undefined && (
          <RenameAccount
            name={renaming}
            onSaved={async () => {
              await runtime.queries.invalidateQueries();
              setRenaming(undefined);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={signingIn !== undefined}
        onOpenChange={(open) => {
          if (!open) setSigningIn(undefined);
        }}
        title={`${signingIn && !isSubscription(signingIn.backend) ? 'Change key for' : 'Sign in to'} ${signingIn?.name ?? 'account'}`}
      >
        {signingIn && (
          <AccountSignIn
            account={signingIn}
            onDone={async () => {
              await runtime.queries.invalidateQueries();
              setSigningIn(undefined);
            }}
          />
        )}
      </Dialog>
    </section>
  );
}

function AccountForm({ onSaved }: { onSaved: (account: Schema['AccountView']) => Promise<void> }) {
  const { api } = useConnection();
  const action = useAction();
  const [draft, setDraft] = useState<AccountDraft>({
    name: '',
    backend: 'anthropic-messages',
    base_url: '',
    api_key: '',
    client_id: '',
    oauth_token_url: '',
    interleaved_thinking: '',
    prompt_cache_key: '',
    stream_usage: '',
    max_tool_name_bytes: '',
  });
  const set = (patch: Partial<AccountDraft>) => setDraft((old) => ({ ...old, ...patch }));
  const subscription = isSubscription(draft.backend);
  const toggle = (
    key: 'interleaved_thinking' | 'prompt_cache_key' | 'stream_usage',
    label: string,
  ) =>
    readsAccountKey(draft.backend, key) && (
      <Field label={label}>
        <select value={draft[key]} onChange={(event) => set({ [key]: event.target.value })}>
          {['', 'true', 'false'].map((value) => (
            <option key={value} value={value}>
              {optionLabels[value]}
            </option>
          ))}
        </select>
      </Field>
    );
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!api) return;
      const account = await api.mutate<Schema['AccountView']>(
        'POST',
        '/v1/accounts',
        createAccountBody(draft),
      );
      await onSaved(account);
    });
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <fieldset className="form-stack" disabled={action.busy}>
        <Field label="Name">
          <input
            required
            value={draft.name}
            onChange={(event) => set({ name: event.target.value })}
            placeholder="anthropic"
          />
        </Field>
        <Field label="Backend">
          <select value={draft.backend} onChange={(event) => set({ backend: event.target.value })}>
            {BACKENDS.map((backend) => (
              <option key={backend.id} value={backend.id}>
                {backend.label}
              </option>
            ))}
          </select>
        </Field>
        {!subscription && (
          <Field label="API key">
            <input
              required
              type="password"
              autoComplete="off"
              value={draft.api_key}
              onChange={(event) => set({ api_key: event.target.value })}
            />
          </Field>
        )}
        <Field label="Base URL">
          <input
            type="url"
            spellCheck={false}
            placeholder="Provider’s own endpoint"
            value={draft.base_url}
            onChange={(event) => set({ base_url: event.target.value })}
          />
        </Field>
        <details>
          <summary>Advanced</summary>
          <div className="form-stack">
            {subscription && (
              <>
                <Field label="OAuth client ID">
                  <input
                    spellCheck={false}
                    placeholder="Default"
                    value={draft.client_id}
                    onChange={(event) => set({ client_id: event.target.value })}
                  />
                </Field>
                <Field label="OAuth token URL">
                  <input
                    type="url"
                    spellCheck={false}
                    placeholder="Default"
                    value={draft.oauth_token_url}
                    onChange={(event) => set({ oauth_token_url: event.target.value })}
                  />
                </Field>
              </>
            )}
            {toggle('interleaved_thinking', 'Interleaved thinking header')}
            {toggle('prompt_cache_key', 'Prompt cache key')}
            {toggle('stream_usage', 'Streamed usage')}
            {readsAccountKey(draft.backend, 'max_tool_name_bytes') && (
              <Field label="Max tool name bytes">
                <input
                  type="number"
                  min={16}
                  step={1}
                  inputMode="numeric"
                  placeholder="Default"
                  value={draft.max_tool_name_bytes}
                  onChange={(event) => set({ max_tool_name_bytes: event.target.value })}
                />
              </Field>
            )}
          </div>
        </details>
        <ErrorNotice error={action.error} />
        <div className="actions">
          <Button type="submit" disabled={action.busy}>
            {action.busy ? 'Adding…' : 'Add account'}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function RenameAccount({ name, onSaved }: { name: string; onSaved: () => Promise<void> }) {
  const { api } = useConnection();
  const action = useAction();
  const [value, setValue] = useState(name);
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!api) return;
      if (value.trim() !== name)
        await api.mutate('PATCH', `/v1/accounts/${segment(name)}`, {
          name: value.trim(),
        } satisfies Schema['RenameRequest']);
      await onSaved();
    });
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <fieldset className="form-stack" disabled={action.busy}>
        <Field label="Name">
          <input required value={value} onChange={(event) => setValue(event.target.value)} />
        </Field>
        <ErrorNotice error={action.error} />
        <div className="actions">
          <Button type="submit" disabled={action.busy}>
            {action.busy ? 'Saving…' : 'Rename'}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function AccountSignIn({
  account,
  onDone,
}: {
  account: Schema['AccountView'];
  onDone: () => Promise<void>;
}) {
  const { api } = useConnection();
  const action = useAction();
  const [key, setKey] = useState('');
  const [started, setStarted] = useState<Schema['LoginStarted']>();
  const path = `/v1/accounts/${segment(account.name)}/login`;
  if (!isSubscription(account.backend)) {
    const submit = async (event: FormEvent) => {
      event.preventDefault();
      await action.run(async () => {
        if (!api) return;
        await api.mutate('POST', path, { api_key: key.trim() } satisfies Schema['LoginRequest']);
        await onDone();
      });
    };
    return (
      <form onSubmit={(event) => void submit(event)}>
        <fieldset className="form-stack" disabled={action.busy}>
          <Field label="API key" hint="Replaces the stored key.">
            <input
              required
              type="password"
              autoComplete="off"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
          <ErrorNotice error={action.error} />
          <div className="actions">
            <Button type="submit" disabled={action.busy}>
              {action.busy ? 'Saving…' : 'Save key'}
            </Button>
          </div>
        </fieldset>
      </form>
    );
  }
  // Each start replaces a login still pending, so it waits for a press rather than the dialog.
  const begin = () =>
    void action.run(async () => {
      if (!api) return;
      setStarted(undefined);
      setStarted(await api.mutate<Schema['LoginStarted']>('POST', path));
    });
  if (started)
    return (
      <BrowserLogin
        key={started.login_id}
        started={started}
        path={`${path}/${segment(started.login_id)}`}
        onDone={onDone}
        onRestart={begin}
      />
    );
  return (
    <div className="form-stack">
      <p className="muted small">
        {backendLabel(account.backend)} signs in through the browser.
        {account.authenticated === 'yes' && ' Signing in again replaces the stored sign-in.'}
      </p>
      <ErrorNotice error={action.error} />
      <div className="actions">
        <Button disabled={action.busy} onClick={begin}>
          <LogIn size={16} />
          {action.busy ? 'Starting…' : 'Start sign-in'}
        </Button>
      </div>
    </div>
  );
}
