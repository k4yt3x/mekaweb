import { useAction } from '../components/actions';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useConnection,
  useGateway,
  useResource,
  useRuntime,
  useSettings,
} from '../connections/context';
import {
  CONVERSATION_FONT,
  CONVERSATION_OFFSET,
  CONVERSATION_WIDTH,
  TERMINAL_FONT,
} from '../connections/storage';
import type { Schema } from '../api/client';
import type { Gateway } from '../api/gateway';
import { Button } from '../components/ui/button';
import { SwitchField } from '../components/ui/switch';
import { ErrorNotice, Field, Json, Loading, Timestamp } from '../components/common';
import { PixelInput } from '../components/pixel-input';
import { appleKeyboard } from '../components/shortcut-keys';
import { NotificationSettings } from '../notifications/settings';
import { AccountSettings } from './account';

export function SettingsPage() {
  const settings = useSettings();
  const runtime = useRuntime();
  const state = useConnection();
  const action = useAction();
  const queries = useQueryClient();
  const status = useGateway<Gateway['StatusView']>('/api/status', undefined, true, 30_000);
  const meka = status.data?.meka;
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
      </header>
      <AccountSettings />
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
              hint="Negative moves it left. Press Enter to apply."
              onCommit={(offset) => {
                if (typeof offset === 'number') runtime.storage.conversationOffset(offset);
              }}
            />
          </Field>
          {status.data?.features.terminal && (
            <Field label="Terminal font size">
              <PixelInput
                label="Terminal font size"
                value={settings.terminalFontSize}
                step={1}
                min={TERMINAL_FONT.min}
                hint={
                  appleKeyboard()
                    ? 'Cmd with =, - or 0, or a pinch, changes it until the terminal is hidden.'
                    : 'Ctrl with the wheel, =, - or 0 changes it until the terminal is hidden.'
                }
                onCommit={(size) => {
                  if (typeof size === 'number') runtime.storage.terminalFontSize(size);
                }}
              />
            </Field>
          )}
        </div>
        <div className="panel-footer">
          <Button
            variant="secondary"
            disabled={
              settings.conversationFontSize === CONVERSATION_FONT.default &&
              settings.conversationMaxWidth === CONVERSATION_WIDTH.default &&
              settings.conversationAnchor === 'page' &&
              settings.conversationOffset === CONVERSATION_OFFSET.default &&
              settings.terminalFontSize === TERMINAL_FONT.default
            }
            title="Reset the font sizes, width, and position; the color theme is kept"
            onClick={() => {
              runtime.storage.resetConversationAppearance();
              runtime.storage.terminalFontSize(TERMINAL_FONT.default);
            }}
          >
            <RotateCcw size={16} />
            Restore defaults
          </Button>
        </div>
      </section>
      <section className="panel">
        <h2>Data saver</h2>
        <SwitchField
          label="Save mobile data on this device"
          checked={settings.dataSaver}
          onCheckedChange={(checked) => runtime.storage.dataSaver(checked)}
        />
        <p className="muted small">Fewer messages, pictures on tap, and batched replies.</p>
      </section>
      <NotificationSettings />
      <section className="panel">
        <h2>meka</h2>
        <dl className="facts">
          <dt>State</dt>
          <dd>
            {!meka ? (
              'Checking…'
            ) : meka.reachable ? (
              <span className="badge success">Answering</span>
            ) : (
              <>
                <span className="badge danger">Not answering</span>
                {meka.error && <span className="muted small"> {meka.error}</span>}
              </>
            )}
          </dd>
          <dt>meka version</dt>
          <dd>
            {meka?.version ?? state.info?.version}
            {meka?.version && meka.reachable && !meka.supported && status.data && (
              <span className="muted">
                {' '}
                · Too old: this mekaweb needs meka {status.data.versions.minimum} or newer.
              </span>
            )}
            {meka?.version && meka.reachable && meka.supported && !meka.verified && status.data && (
              <span className="muted">
                {' '}
                · Untested with this mekaweb (tested: {status.data.versions.verified.join(', ')}).
              </span>
            )}
          </dd>
          <dt>mekaweb version</dt>
          <dd>{status.data?.version ?? __MEKAWEB_VERSION__}</dd>
          <dt>Liveness</dt>
          <dd>{live.isPending ? 'Checking…' : (live.data?.status ?? 'Unavailable')}</dd>
          <dt>Readiness</dt>
          <dd>{ready.isPending ? 'Checking…' : (ready.data?.status ?? 'Unavailable')}</dd>
          {meka && (
            <>
              <dt>Last checked</dt>
              <dd>
                <Timestamp value={meka.checked_at} />
              </dd>
            </>
          )}
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
        <ErrorNotice error={status.error ?? live.error ?? ready.error ?? action.error} />
        {ready.data && (
          <details>
            <summary>Readiness details</summary>
            <Json value={ready.data} />
          </details>
        )}
        <div className="actions wrap diagnostic-actions">
          <Button
            variant="secondary"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const fresh = await runtime.gateway.get<Gateway['StatusView']>('/api/status', {
                  check: true,
                });
                queries.setQueryData(
                  ['gateway', runtime.getSnapshot().account?.device_id, '/api/status', undefined],
                  fresh,
                );
                await Promise.all([live.refetch(), ready.refetch()]);
              })
            }
          >
            <RefreshCw size={16} className={action.busy ? 'spin' : undefined} />
            Check now
          </Button>
          {/* meka 0.82.0 serves no API browser; its book documents the API instead. */}
          <a
            className="button button-secondary"
            href="https://docs.meka.run/usage/http-api.html"
            target="_blank"
            rel="noreferrer noopener"
          >
            API reference ↗
          </a>
        </div>
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
        <div className="bounded">
          {profiles.data?.profiles.map((p) => (
            <div className="setting-row" key={p.name}>
              <strong>
                {p.name}
                {p.active && <span className="badge">Default</span>}
              </strong>
              <span className="muted">
                {p.model ?? 'No model'} · {p.backend ?? 'Backend unavailable'} · Account:{' '}
                {p.account} · {p.vision ? 'Images' : 'No images'}
              </span>
            </div>
          ))}
        </div>
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
              <pre className="plain-text bounded" tabIndex={0} aria-label="Standing instructions">
                {instructions.data.content}
              </pre>
            </>
          ) : (
            !instructions.error && (
              <p className="muted small">No standing instructions configured.</p>
            )
          )}
        </section>
      )}
    </div>
  );
}
