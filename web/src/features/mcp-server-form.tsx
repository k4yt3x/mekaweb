import { useState, type FormEvent, type ReactNode } from 'react';
import { LogIn, LogOut, X } from 'lucide-react';
import { useAction } from '../components/actions';
import { useConnection } from '../connections/context';
import { segment, type Schema } from '../api/client';
import { Button } from '../components/ui/button';
import { SwitchField } from '../components/ui/switch';
import { ErrorNotice, Field } from '../components/common';
import { BrowserLogin } from './browser-login';
import {
  AUTH_KINDS,
  DEFERRALS,
  PERMISSIONS,
  createMcpBody,
  mcpDraft,
  patchMcpBody,
  type McpDraft,
} from './mcp-model';

/** Adds an MCP server, or edits one by the keys meka reports of it. */
export function McpServerForm({
  initial,
  onSaved,
}: {
  initial?: Schema['McpServerDetail'];
  onSaved: () => Promise<void>;
}) {
  const { api } = useConnection();
  const action = useAction();
  const [start] = useState(() => mcpDraft(initial));
  const [draft, setDraft] = useState(start);
  const set = (patch: Partial<McpDraft>) => setDraft((old) => ({ ...old, ...patch }));
  const http = draft.transport === 'http';
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!api) return;
      if (initial)
        await api.mutate('PATCH', `/v1/mcp/${segment(initial.name)}`, patchMcpBody(start, draft));
      else await api.mutate('POST', '/v1/mcp', createMcpBody(draft));
      await onSaved();
    });
  }
  const text = (key: keyof McpDraft, label: string, hint?: string, props: object = {}) => (
    <Field label={label} hint={hint}>
      <input
        spellCheck={false}
        value={draft[key] as string}
        onChange={(event) => set({ [key]: event.target.value })}
        {...props}
      />
    </Field>
  );
  const area = (key: keyof McpDraft, label: string, hint?: string, placeholder?: string) => (
    <Field label={label} hint={hint}>
      <textarea
        spellCheck={false}
        value={draft[key] as string}
        placeholder={placeholder}
        onChange={(event) => set({ [key]: event.target.value })}
      />
    </Field>
  );
  const select = (
    key: keyof McpDraft,
    label: string,
    options: ReactNode,
    hint?: string,
    disabled = false,
  ) => (
    <Field label={label} hint={hint}>
      <select
        disabled={disabled}
        value={draft[key] as string}
        onChange={(event) => set({ [key]: event.target.value })}
      >
        {options}
      </select>
    </Field>
  );
  /** The keys already set, each removable; their values are never shown. */
  const kept = (key: 'envKeys' | 'headerKeys') =>
    draft[key].length > 0 && (
      <div className="fallback-list">
        <span className="muted small">Set:</span>
        {draft[key].map((name) => (
          <span className="tag" key={name}>
            {name}
            <button
              type="button"
              className="tag-remove"
              aria-label={`Remove ${name}`}
              onClick={() => set({ [key]: draft[key].filter((other) => other !== name) })}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
    );
  const secretHint = initial ? 'Empty keeps the stored one.' : undefined;
  return (
    <form onSubmit={(event) => void submit(event)}>
      <fieldset className="form-stack" disabled={action.busy}>
        <div className="form-grid">
          {text('name', 'Name', undefined, {
            required: true,
            disabled: Boolean(initial),
            pattern: '[A-Za-z0-9_\\-]+',
          })}
          {select(
            'transport',
            'Transport',
            <>
              <option value="stdio">Command (stdio)</option>
              <option value="http">HTTP</option>
            </>,
            initial ? 'Another transport is another server.' : undefined,
            Boolean(initial),
          )}
        </div>
        {http ? (
          <>
            {text('url', 'URL', undefined, { required: true, type: 'url' })}
            {area(
              'headers',
              'Headers',
              initial ? 'Values aren’t shown; one entered here replaces it.' : undefined,
              'Name: value',
            )}
            {kept('headerKeys')}
            {select(
              'auth',
              'Authentication',
              AUTH_KINDS.map((kind) => (
                <option key={kind.id} value={kind.id}>
                  {kind.label}
                </option>
              )),
            )}
            {draft.auth === 'token' &&
              text('auth_token', 'Token', secretHint, { type: 'password', autoComplete: 'off' })}
            {(draft.auth === 'oauth' ||
              draft.auth === 'client_credentials' ||
              draft.auth === 'client_credentials_jwt') && (
              <div className="form-grid">
                {text(
                  'client_id',
                  'Client ID',
                  draft.auth === 'oauth' ? 'Empty registers one.' : undefined,
                  { required: draft.auth !== 'oauth' },
                )}
                {text('scopes', 'Scopes', 'Comma-separated.')}
                {draft.auth === 'oauth' &&
                  text('redirect_port', 'Redirect port', 'Empty picks a free one.', {
                    type: 'number',
                    min: 1,
                    max: 65535,
                  })}
                {draft.auth === 'client_credentials' &&
                  text('client_secret', 'Client secret', secretHint, {
                    type: 'password',
                    autoComplete: 'off',
                    required: !initial,
                  })}
                {draft.auth === 'client_credentials_jwt' &&
                  text('signing_key_path', 'Signing key path', 'A PEM file on meka’s machine.', {
                    required: true,
                  })}
                {draft.auth === 'client_credentials_jwt' &&
                  select(
                    'signing_algorithm',
                    'Signing algorithm',
                    ['', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384'].map((value) => (
                      <option key={value} value={value}>
                        {value || 'Default (RS256)'}
                      </option>
                    )),
                  )}
              </div>
            )}
          </>
        ) : (
          <>
            {text('command', 'Command', 'Runs on meka’s machine, as meka’s user.', {
              required: true,
            })}
            {area('args', 'Arguments', 'One per line.')}
            {area(
              'env',
              'Environment',
              initial ? 'Values aren’t shown; one entered here replaces it.' : undefined,
              'KEY=value',
            )}
            {kept('envKeys')}
          </>
        )}
        <details>
          <summary>Tools and permissions</summary>
          <div className="form-stack">
            {select(
              'permission',
              'Permission',
              ['', ...PERMISSIONS].map((value) => (
                <option key={value} value={value}>
                  {value || 'By each tool’s hint'}
                </option>
              )),
              'The level every tool of this server needs.',
            )}
            {area('tool_permissions', 'Per-tool permissions', undefined, 'tool=read')}
            {area('allowed_tools', 'Only these tools', 'Raw names, one per line or comma.')}
            {area('disabled_tools', 'Never these tools')}
            {area('eager_load_tools', 'Always loaded tools')}
            {select(
              'deferral',
              'Other tools',
              ['', ...DEFERRALS].map((value) => (
                <option key={value} value={value}>
                  {value || 'Default'}
                </option>
              )),
            )}
            {select(
              'trust_read_only_hint',
              'Trust read-only hints',
              ['', 'true', 'false'].map((value) => (
                <option key={value} value={value}>
                  {value === '' ? 'Default (yes)' : value === 'true' ? 'Yes' : 'No'}
                </option>
              )),
            )}
            {http &&
              text('headers_helper', 'Headers helper', 'A command whose output adds headers.')}
            {select(
              'required',
              'Required',
              ['', 'true', 'false'].map((value) => (
                <option key={value} value={value}>
                  {value === '' ? 'Default' : value === 'true' ? 'Turns wait for it' : 'Optional'}
                </option>
              )),
            )}
          </div>
        </details>
        <SwitchField
          label="Enabled"
          checked={!draft.disabled}
          onCheckedChange={(checked) => set({ disabled: !checked })}
        />
        <ErrorNotice error={action.error} />
        <div className="actions">
          <Button type="submit" disabled={action.busy}>
            {action.busy ? 'Saving…' : initial ? 'Save' : 'Add server'}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

/** Signs an HTTP server in by what its entry presents: a token, a client secret, or OAuth in the
 * browser. Signing out clears every credential stored for it, for any endpoint. */
export function McpSignIn({
  detail,
  onDone,
}: {
  detail: Schema['McpServerDetail'];
  onDone: () => Promise<void>;
}) {
  const { api } = useConnection();
  const action = useAction();
  const [secret, setSecret] = useState('');
  const [started, setStarted] = useState<Schema['LoginStarted']>();
  const path = `/v1/mcp/${segment(detail.name)}/login`;
  const type = detail.auth?.type;
  const secretKind = type === 'client_credentials' ? 'client_secret' : 'auth_token';
  const takesSecret = !type || type === 'client_credentials';
  const takesBrowser = !type || type === 'oauth';
  const elsewhere = detail.credentials_for_another_endpoint ?? [];
  const stored = Boolean(detail.credentials?.length || elsewhere.length);
  const begin = () =>
    void action.run(async () => {
      if (!api) return;
      setStarted(undefined);
      // A server whose secret is already stored connects at once, with the server as the answer.
      const answer = await api.mutate<Schema['LoginStarted'] | Schema['McpServerStatus']>(
        'POST',
        path,
      );
      if ('login_id' in answer) setStarted(answer);
      else await onDone();
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
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!api) return;
      await api.mutate('POST', path, {
        [secretKind]: secret.trim(),
      } satisfies Schema['McpLoginRequest']);
      await onDone();
    });
  }
  return (
    <div className="form-stack">
      {detail.credentials?.length ? (
        <p className="muted small">Stored: {detail.credentials.join(', ')}.</p>
      ) : null}
      {elsewhere.map((credential) => (
        <p className="muted small" key={credential.kind + (credential.stored_for ?? '')}>
          Not sent: {credential.kind}
          {credential.stored_for ? `, stored for ${credential.stored_for}` : ''}.
        </p>
      ))}
      {takesSecret && (
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          <Field label={secretKind === 'client_secret' ? 'Client secret' : 'Bearer token'}>
            <input
              required
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
          <div className="actions">
            <Button type="submit" disabled={action.busy}>
              Save
            </Button>
          </div>
        </form>
      )}
      {takesBrowser && (
        <div className="actions">
          <Button
            variant={takesSecret ? 'secondary' : 'default'}
            disabled={action.busy}
            onClick={begin}
          >
            <LogIn size={16} />
            Sign in through the browser
          </Button>
        </div>
      )}
      {!takesSecret && !takesBrowser && (
        <p className="muted small">
          This server signs in with its key file; there is nothing to enter.
        </p>
      )}
      <ErrorNotice error={action.error} />
      {stored ? (
        <div className="panel-footer">
          <Button
            variant="ghost"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api?.mutate('POST', `/v1/mcp/${segment(detail.name)}/logout`);
                await onDone();
              })
            }
          >
            <LogOut size={16} />
            Sign out
          </Button>
        </div>
      ) : null}
    </div>
  );
}
