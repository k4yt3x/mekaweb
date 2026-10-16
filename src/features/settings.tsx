import { useAction } from '../components/actions';
import { useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  KeyRound,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Unplug,
} from 'lucide-react';
import { useConnection, useResource, useRuntime, useSettings } from '../connections/context';
import type { Connection } from '../connections/storage';
import { CONVERSATION_FONT, CONVERSATION_OFFSET, CONVERSATION_WIDTH } from '../connections/storage';
import { download, normalizeEndpoint, type Schema } from '../api/client';
import { Button } from '../components/ui/button';
import { SwitchField } from '../components/ui/switch';
import { Dialog } from '../components/ui/dialog';
import { ConfirmButton, ErrorNotice, Field, Json, Loading } from '../components/common';
import { MekawebLink } from '../components/layout';
import { PixelInput } from '../components/pixel-input';
import { verifiedVersions } from '../api/version';
import { NotificationSettings } from '../notifications/settings';
import { ImportSettingsButton, SettingsTransferPanel } from './settings-transfer';

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
  let normalized: string | undefined;
  try {
    normalized = normalizeEndpoint(endpoint);
  } catch {
    // A partially entered URL is not a new endpoint yet.
  }
  const endpointChanged = Boolean(existing && normalized && normalized !== existing.endpoint);
  // A saved token can stay for the same endpoint, but is never sent to a new one unasked.
  const saved = existing && normalized === existing.endpoint ? runtime.storage.token(existing) : '';
  const renaming = Boolean(saved) && !token.trim() && remember === existing?.remember;
  const action = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (existing && renaming) {
      runtime.storage.rename(existing.id, name);
      onConnected?.();
      return;
    }
    await action.run(async () => {
      const ok = await runtime.save(
        name,
        endpoint,
        token.trim() || saved || '',
        remember,
        existing?.id,
      );
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
          required={!saved}
          placeholder={
            saved
              ? 'Leave blank to keep the saved token'
              : endpointChanged
                ? 'Enter the token again for the new URL'
                : undefined
          }
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
          ) : renaming ? (
            'Save'
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
  const available = settings.connections.filter((c) => !c.suspended);
  const suspended = settings.connections.filter((c) => c.suspended);
  function open(c: Connection) {
    if (runtime.storage.token(c)) void runtime.connect(c);
    else {
      runtime.cancelConnect();
      setExisting(c);
    }
  }
  return (
    <main className="welcome">
      <section className="connection-card" aria-label="Connect to meka">
        <h1>meka</h1>
        {available.length > 0 && (
          <div className="saved-connections">
            {available.map((c) => (
              <Button key={c.id} variant="secondary" onClick={() => open(c)}>
                {c.name} <span className="muted small">{new URL(c.endpoint).host}</span>
              </Button>
            ))}
          </div>
        )}
        {suspended.length > 0 && (
          <details className="suspended-connections">
            <summary>
              {suspended.length} suspended connection{suspended.length === 1 ? '' : 's'}
            </summary>
            <div className="saved-connections">
              {suspended.map((c) => (
                <Button
                  key={c.id}
                  variant="ghost"
                  title="Resume this connection and connect to it"
                  onClick={() => {
                    runtime.storage.suspend(c.id, false);
                    open(runtime.storage.getSnapshot().connections.find((r) => r.id === c.id) ?? c);
                  }}
                >
                  {c.name} <span className="muted small">{new URL(c.endpoint).host}</span>
                </Button>
              ))}
            </div>
          </details>
        )}
        <ConnectionForm key={existing?.id ?? 'new'} existing={existing} />
        <div className="welcome-import">
          <ImportSettingsButton />
        </div>
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
  const [moved, setMoved] = useState('');
  const action = useAction();
  function move(c: Connection, offset: -1 | 1) {
    runtime.storage.moveConnection(c.id, offset);
    const { connections } = runtime.storage.getSnapshot();
    const position = connections.findIndex((other) => other.id === c.id);
    setMoved(`Moved ${c.name} to position ${position + 1} of ${connections.length}.`);
    // Keep focus on the moved row, on the other arrow once this one reaches an end.
    requestAnimationFrame(() => {
      const buttons = ['up', 'down'].map((direction) =>
        document.querySelector<HTMLButtonElement>(`[data-move="${c.id}:${direction}"]`),
      );
      const [preferred, other] = offset < 0 ? buttons : buttons.reverse();
      (preferred && !preferred.disabled ? preferred : other)?.focus();
    });
  }
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
        {settings.connections.map((c, index) => (
          <div
            className={`setting-row connection-row ${settings.connections.length > 1 ? 'orderable' : ''} ${c.suspended ? 'suspended' : ''}`}
            key={c.id}
          >
            {settings.connections.length > 1 && (
              <div className="connection-order">
                <Button
                  variant="ghost"
                  size="icon"
                  data-move={`${c.id}:up`}
                  aria-label={`Move ${c.name} up`}
                  title="Move up"
                  disabled={index === 0}
                  onClick={() => move(c, -1)}
                >
                  <ChevronUp size={16} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  data-move={`${c.id}:down`}
                  aria-label={`Move ${c.name} down`}
                  title="Move down"
                  disabled={index === settings.connections.length - 1}
                  onClick={() => move(c, 1)}
                >
                  <ChevronDown size={16} />
                </Button>
              </div>
            )}
            <div className="connection-details">
              <strong>{c.name}</strong>
              {state.connection?.id === c.id && (
                <span className="badge">{state.connectionIssue ? 'Active' : 'Connected'}</span>
              )}
              {c.suspended && <span className="badge">Suspended</span>}
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
              <Button
                variant="ghost"
                aria-label={`${c.suspended ? 'Resume' : 'Suspend'} ${c.name}`}
                title={
                  c.suspended
                    ? 'Show this connection in the switcher again'
                    : state.connection?.id === c.id
                      ? 'Disconnect and hide this connection from the switcher until you resume it'
                      : 'Hide this connection from the switcher until you resume it'
                }
                onClick={() => {
                  runtime.storage.suspend(c.id, !c.suspended);
                  if (!c.suspended && state.connection?.id === c.id) runtime.disconnect();
                }}
              >
                {c.suspended ? <Play size={14} /> : <Pause size={14} />}
                {c.suspended ? 'Resume' : 'Suspend'}
              </Button>
              <Button
                variant="ghost"
                tone="danger"
                title="Delete this connection's saved token from this browser"
                onClick={() => runtime.storage.forget(c.id)}
              >
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
        <span className="sr-only" aria-live="polite">
          {moved}
        </span>
        <div className="panel-footer">
          <Button variant="secondary" tone="danger" onClick={() => runtime.disconnect()}>
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
          <Field label="Center conversation on">
            <select
              value={settings.conversationAnchor}
              onChange={(event) =>
                runtime.storage.conversationAnchor(event.target.value === 'area' ? 'area' : 'page')
              }
            >
              <option value="page">Page</option>
              <option value="area">Conversation area</option>
            </select>
          </Field>
          <Field label="Conversation offset">
            <PixelInput
              label="Conversation offset"
              value={settings.conversationOffset}
              step={CONVERSATION_OFFSET.step}
              min={-CONVERSATION_OFFSET.limit}
              hint="Pixels to move the conversation; negative moves it left. It stays between the panels. Press Enter to apply."
              onCommit={(offset) => {
                if (typeof offset === 'number') runtime.storage.conversationOffset(offset);
              }}
            />
          </Field>
        </div>
        <div className="panel-footer">
          <Button
            variant="secondary"
            disabled={
              settings.conversationFontSize === CONVERSATION_FONT.default &&
              settings.conversationMaxWidth === CONVERSATION_WIDTH.default &&
              settings.conversationAnchor === 'page' &&
              settings.conversationOffset === CONVERSATION_OFFSET.default
            }
            title="Reset the conversation font size, width, and position; the color theme is kept"
            onClick={() => runtime.storage.resetConversationAppearance()}
          >
            <RotateCcw size={16} />
            Restore defaults
          </Button>
        </div>
      </section>
      <NotificationSettings />
      <SettingsTransferPanel />
      <section className="panel">
        <h2>Diagnostics</h2>
        <dl className="facts">
          <dt>mekaweb version</dt>
          <dd>{__MEKAWEB_VERSION__}</dd>
          <dt>meka version</dt>
          <dd>
            {state.info?.version}
            {!verifiedVersions.includes(state.info?.version ?? '') && (
              <span className="muted">
                {' '}
                · Unverified version (verified: {verifiedVersions.join(', ')}).
              </span>
            )}
          </dd>
          <dt>Liveness</dt>
          <dd>{live.isPending ? 'Checking…' : (live.data?.status ?? 'Unavailable')}</dd>
          <dt>Readiness</dt>
          <dd>{ready.isPending ? 'Checking…' : (ready.data?.status ?? 'Unavailable')}</dd>
          <dt>Default permission</dt>
          <dd>{state.info?.default_permission}</dd>
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
              {p.model ?? 'No model'} · {p.backend ?? 'Backend unavailable'} · Account: {p.account}{' '}
              · {p.vision ? 'Images' : 'No images'}
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
