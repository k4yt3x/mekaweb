import { useAction } from '../components/actions';
import { useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Plus, Unplug, KeyRound } from 'lucide-react';
import { useConnection, useResource, useRuntime, useSettings } from '../connections/context';
import type { Connection } from '../connections/storage';
import { CONVERSATION_FONT, CONVERSATION_WIDTH } from '../connections/storage';
import { download, normalizeEndpoint, type Schema } from '../api/client';
import { Button } from '../components/ui/button';
import { SwitchField } from '../components/ui/switch';
import { Dialog } from '../components/ui/dialog';
import { ConfirmButton, ErrorNotice, Field, Json, Loading } from '../components/common';
import { MekawebLink } from '../components/layout';
import { PixelInput } from '../components/pixel-input';
import { supportedVersions } from '../api/version';
import { NotificationSettings } from '../notifications/settings';

export function ConnectionForm({
  existing,
  onConnected,
}: {
  existing?: Connection | undefined;
  onConnected?: () => void;
}) {
  const runtime = useRuntime();
  const state = useConnection();
  const [name, setName] = useState(existing?.name ?? '');
  const [endpoint, setEndpoint] = useState(existing?.endpoint ?? '');
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(existing?.remember ?? true);
  const connectButton = useRef<HTMLButtonElement>(null);
  let endpointChanged = false;
  if (existing) {
    try {
      endpointChanged = normalizeEndpoint(endpoint) !== existing.endpoint;
    } catch {
      // A partially entered URL is not a new endpoint yet.
    }
  }
  const action = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      const ok = await runtime.save(name, endpoint, token, remember, existing?.id);
      if (ok) {
        setToken('');
        onConnected?.();
      }
    });
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="form-stack">
      <Field label="Connection name">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Personal meka"
          autoComplete="off"
        />
      </Field>
      <Field
        label="Meka base URL"
        hint={
          endpointChanged
            ? 'Changing the URL replaces this connection and clears its local drafts.'
            : undefined
        }
      >
        <input
          type="url"
          required
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder="https://meka.example.com"
          autoComplete="url"
        />
      </Field>
      <Field label="API token">
        <input
          type="password"
          required
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field label="Token storage">
        <select
          value={remember ? 'localStorage' : 'sessionStorage'}
          onChange={(event) => setRemember(event.target.value === 'localStorage')}
        >
          <option value="localStorage">Local storage (persistent)</option>
          <option value="sessionStorage">Session storage (this tab)</option>
        </select>
      </Field>
      <ErrorNotice error={action.error ?? (state.error ? new Error(state.error) : undefined)} />
      <div className="connection-actions">
        <Button ref={connectButton} type="submit" disabled={state.busy || action.busy}>
          {state.busy ? (
            <Loading label="Connecting…" />
          ) : (
            <>
              Connect <ArrowRight size={16} />
            </>
          )}
        </Button>
        {state.busy && (
          <Button
            type="button"
            variant="secondary"
            aria-label="Cancel connection"
            onClick={() => {
              runtime.cancelConnect();
              requestAnimationFrame(() => connectButton.current?.focus());
            }}
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
export function Welcome() {
  const settings = useSettings();
  const runtime = useRuntime();
  const [existing, setExisting] = useState<Connection>();
  return (
    <main className="welcome">
      <section className="connection-card" aria-label="Connect to meka">
        <h1>meka</h1>
        {settings.connections.length > 0 && (
          <div className="saved-connections">
            {settings.connections.map((c) => (
              <Button
                key={c.id}
                variant="secondary"
                onClick={() => {
                  if (runtime.storage.token(c)) void runtime.connect(c);
                  else {
                    runtime.cancelConnect();
                    setExisting(c);
                  }
                }}
              >
                {c.name} <span className="muted small">{new URL(c.endpoint).host}</span>
              </Button>
            ))}
          </div>
        )}
        <ConnectionForm key={existing?.id ?? 'new'} existing={existing} />
      </section>
      <footer className="app-version">
        <MekawebLink /> version {__MEKAWEB_VERSION__}
      </footer>
    </main>
  );
}
export function SettingsPage() {
  const settings = useSettings();
  const runtime = useRuntime();
  const state = useConnection();
  const [edit, setEdit] = useState<Connection | 'new'>();
  const action = useAction();
  const live = useResource<Schema['LiveResponse']>('/v1/health/live');
  const ready = useResource<Schema['ReadyResponse']>('/v1/health/ready');
  const profiles = useResource<Schema['ProfilesResponse']>('/v1/profiles');
  const instructions = useResource<Schema['InstructionsResponse']>(
    '/v1/instructions',
    undefined,
    state.info?.scopes.includes('sessions:r'),
  );
  return (
    <div className="page settings-page">
      <header className="page-heading">
        <div>
          <h1>Settings</h1>
        </div>
        <Button onClick={() => setEdit('new')}>
          <Plus size={16} />
          Add connection
        </Button>
      </header>
      <section className="panel">
        <h2>Connections</h2>
        {settings.connections.map((c) => (
          <div className="setting-row" key={c.id}>
            <div>
              <strong>{c.name}</strong>
              {state.connection?.id === c.id && (
                <span className="badge">{state.connectionIssue ? 'Active' : 'Connected'}</span>
              )}
              <p className="muted small break">{c.endpoint}</p>
              <small className="muted">
                Token storage:{' '}
                {c.remember ? 'Local storage (persistent)' : 'Session storage (this tab)'}
              </small>
            </div>
            <div className="actions wrap">
              <Button
                variant="secondary"
                aria-label="Edit / replace token"
                title="Edit connection or replace token"
                onClick={() => setEdit(c)}
              >
                <KeyRound size={14} />
                Edit
              </Button>
              <Button variant="ghost" onClick={() => runtime.storage.forget(c.id)}>
                Forget token
              </Button>
              <ConfirmButton
                title="Remove connection"
                description="Remove this endpoint, its saved token, and local drafts. Server data is unaffected."
                onConfirm={() => {
                  runtime.storage.remove(c.id);
                  return Promise.resolve();
                }}
              >
                Remove
              </ConfirmButton>
            </div>
          </div>
        ))}
        <div className="panel-footer">
          <Button variant="secondary" onClick={() => runtime.disconnect()}>
            <Unplug size={16} />
            Disconnect
          </Button>
        </div>
      </section>
      <section className="panel appearance-panel">
        <h2>Appearance</h2>
        <div className="appearance-fields">
          <Field label="Color theme">
            <select
              value={settings.theme}
              onChange={(event) =>
                runtime.storage.theme(event.target.value as 'system' | 'light' | 'dark')
              }
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </Field>
          <Field label="Conversation font size">
            <PixelInput
              label="Conversation font size"
              value={settings.conversationFontSize}
              step={CONVERSATION_FONT.step}
              onCommit={(size) => {
                if (typeof size === 'number') runtime.storage.conversationFontSize(size);
              }}
            />
          </Field>
          <Field label="Conversation max width">
            <PixelInput
              label="Conversation max width"
              value={settings.conversationMaxWidth}
              step={CONVERSATION_WIDTH.step}
              fullWidthFallback={CONVERSATION_WIDTH.default}
              onCommit={(width) => runtime.storage.conversationMaxWidth(width)}
            />
          </Field>
        </div>
      </section>
      <NotificationSettings />
      <section className="panel">
        <h2>Diagnostics</h2>
        <dl className="facts">
          <dt>mekaweb version</dt>
          <dd>{__MEKAWEB_VERSION__}</dd>
          <dt>meka version</dt>
          <dd>
            {state.info?.version}
            {!supportedVersions.includes(state.info?.version ?? '') && (
              <span className="muted">
                {' '}
                · Unverified version (supported: {supportedVersions.join(', ')}).
              </span>
            )}
          </dd>
          <dt>Liveness</dt>
          <dd>{live.isPending ? 'Checking…' : (live.data?.status ?? 'Unavailable')}</dd>
          <dt>Readiness</dt>
          <dd>{ready.isPending ? 'Checking…' : (ready.data?.status ?? 'Unavailable')}</dd>
          <dt>Default permission</dt>
          <dd>{state.info?.default_permission}</dd>
          <dt>Default vision</dt>
          <dd>{state.info?.vision ? 'Available' : 'Unavailable'}</dd>
          <dt>Token scopes</dt>
          <dd className="scope-list">
            {state.info?.scopes.map((scope) => (
              <span className="tag" key={scope}>
                {scope}
              </span>
            ))}
          </dd>
        </dl>
        <ErrorNotice error={live.error ?? ready.error} />
        {ready.data && (
          <details>
            <summary>Readiness details</summary>
            <Json value={ready.data} />
          </details>
        )}
        <div className="actions wrap diagnostic-actions">
          <Button
            variant="secondary"
            onClick={() => {
              void live.refetch();
              void ready.refetch();
            }}
          >
            Refresh health
          </Button>
          <Button
            variant="secondary"
            title="Requires API documentation to be enabled on the server"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                if (state.api)
                  download(await state.api.blob('/v1/openapi.json'), 'meka-openapi.json');
              })
            }
          >
            Download OpenAPI
          </Button>
          {state.api && (
            <a
              className="button button-secondary"
              href={state.api.url('/v1/docs')}
              title="Requires API documentation to be enabled on the server"
              target="_blank"
              rel="noreferrer noopener"
            >
              API documentation ↗
            </a>
          )}
        </div>
        <ErrorNotice error={action.error} />
        <div className="panel-footer">
          <SwitchField
            label="Show context added by meka"
            checked={settings.showTurnContext}
            onCheckedChange={(checked) => runtime.storage.showTurnContext(checked)}
          />
        </div>
      </section>
      <section className="panel">
        <h2>Profiles</h2>
        <ErrorNotice error={profiles.error} />
        {profiles.data?.profiles.map((p) => (
          <div className="setting-row" key={p.name}>
            <strong>
              {p.name}
              {p.active && <span className="badge">Default</span>}
            </strong>
            <span className="muted">
              {p.model ?? 'No model'} · {p.backend ?? 'Backend unavailable'} · Account: {p.account}
            </span>
          </div>
        ))}
      </section>
      {state.info?.scopes.includes('sessions:r') && (
        <section className="panel">
          <h2>Standing instructions</h2>
          <ErrorNotice error={instructions.error} />
          {instructions.isPending ? (
            <Loading />
          ) : instructions.data?.content ? (
            <>
              {instructions.data.source && (
                <p className="muted small">{instructions.data.source}</p>
              )}
              <pre className="plain-text">{instructions.data.content}</pre>
            </>
          ) : (
            !instructions.error && (
              <p className="muted small">No standing instructions configured.</p>
            )
          )}
        </section>
      )}
      <Dialog
        open={Boolean(edit)}
        onOpenChange={(open) => {
          if (!open) setEdit(undefined);
        }}
        title={edit === 'new' ? 'Add connection' : 'Edit connection'}
      >
        <ConnectionForm
          key={edit === 'new' ? 'new' : edit?.id}
          existing={edit === 'new' ? undefined : edit}
          onConnected={() => setEdit(undefined)}
        />
      </Dialog>
    </div>
  );
}
