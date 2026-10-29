import type { Schema } from '../api/client';

export const PERMISSIONS = ['none', 'read', 'workspace', 'unrestricted'] as const;
export const DEFERRALS = ['deferred', 'eager', 'hidden'] as const;
export const AUTH_KINDS = [
  { id: '', label: 'None' },
  { id: 'token', label: 'Bearer token' },
  { id: 'oauth', label: 'OAuth sign-in' },
  { id: 'client_credentials', label: 'Client credentials' },
  { id: 'client_credentials_jwt', label: 'Client credentials (JWT)' },
] as const;

/** An MCP server entry as its form holds it: lists one item per line, blank for unset. */
export interface McpDraft {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  /** `KEY=value` lines to set. meka never shows the values already set, only their keys. */
  env: string;
  /** Keys already set that the edit keeps; one taken out of this list is removed. */
  envKeys: string[];
  url: string;
  /** `Name: value` lines to set, beside the names already set, as for `env`. */
  headers: string;
  headerKeys: string[];
  headers_helper: string;
  /** The `auth` block's type, or `token` for a bearer presented without one. */
  auth: (typeof AUTH_KINDS)[number]['id'];
  /** A secret to store; blank keeps what is stored. */
  auth_token: string;
  client_secret: string;
  client_id: string;
  scopes: string;
  signing_key_path: string;
  signing_algorithm: string;
  redirect_port: string;
  permission: string;
  allowed_tools: string;
  disabled_tools: string;
  eager_load_tools: string;
  /** Blank leaves it to `[mcp]`. */
  deferral: string;
  /** `tool=level` lines. */
  tool_permissions: string;
  trust_read_only_hint: string;
  /** Blank leaves it to `[mcp]`. */
  required: string;
  disabled: boolean;
}

export function mcpDraft(detail?: Schema['McpServerDetail']): McpDraft {
  const auth = detail?.auth ?? undefined;
  const inherited = (key: string) => !detail || detail.inherited?.includes(key);
  const text = (value: string | number | boolean | null | undefined) =>
    value === null || value === undefined ? '' : String(value);
  return {
    name: detail?.name ?? '',
    transport: detail?.transport === 'http' ? 'http' : 'stdio',
    command: detail?.command ?? '',
    args: (detail?.args ?? []).join('\n'),
    env: '',
    envKeys: detail?.env_keys ?? [],
    url: detail?.url ?? '',
    headers: '',
    headerKeys: detail?.header_keys ?? [],
    headers_helper: detail?.headers_helper ?? '',
    auth: auth?.type ?? (detail?.credentials?.includes('bearer token') ? 'token' : ''),
    auth_token: '',
    client_secret: '',
    client_id: text(auth?.client_id),
    scopes: (auth?.scopes ?? []).join(', '),
    signing_key_path: auth?.type === 'client_credentials_jwt' ? auth.signing_key_path : '',
    signing_algorithm: auth?.type === 'client_credentials_jwt' ? text(auth.signing_algorithm) : '',
    redirect_port: auth?.type === 'oauth' ? text(auth.redirect_port) : '',
    permission: detail?.permission ?? '',
    allowed_tools: (detail?.allowed_tools ?? []).join('\n'),
    disabled_tools: (detail?.disabled_tools ?? []).join('\n'),
    eager_load_tools: (detail?.eager_load_tools ?? []).join('\n'),
    deferral: inherited('deferral') ? '' : text(detail?.deferral),
    tool_permissions: Object.entries(detail?.tool_permissions ?? {})
      .map(([tool, level]) => `${tool}=${level}`)
      .join('\n'),
    trust_read_only_hint: text(detail?.trust_read_only_hint),
    required: inherited('required') ? '' : text(detail?.required),
    disabled: detail?.disabled ?? false,
  };
}

/** One item per line, or per comma for a list of names. */
export function lines(text: string, commas = false) {
  return text
    .split(commas ? /[\n,]/ : '\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
/** `KEY=value` or `Name: value` lines as a map, or the first line that is neither. */
export function pairs(text: string, separator: '=' | ':'): Record<string, string> | string {
  const map: Record<string, string> = {};
  for (const line of lines(text)) {
    const at = line.indexOf(separator);
    if (at < 1) return line;
    map[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return map;
}
function map(text: string, separator: '=' | ':', label: string) {
  const parsed = pairs(text, separator);
  if (typeof parsed === 'string')
    throw new Error(
      `${label}: “${parsed}” is not ${separator === '=' ? 'KEY=value' : 'Name: value'}.`,
    );
  return parsed;
}

function auth(draft: McpDraft): Schema['McpAuthConfig'] | undefined {
  const scopes = lines(draft.scopes, true);
  const common = scopes.length ? { scopes } : {};
  if (draft.auth === 'oauth')
    return {
      type: 'oauth',
      ...(draft.client_id.trim() ? { client_id: draft.client_id.trim() } : {}),
      ...(draft.redirect_port.trim() ? { redirect_port: Number(draft.redirect_port) } : {}),
      ...common,
    };
  if (draft.auth === 'client_credentials')
    return { type: 'client_credentials', client_id: draft.client_id.trim(), ...common };
  if (draft.auth === 'client_credentials_jwt')
    return {
      type: 'client_credentials_jwt',
      client_id: draft.client_id.trim(),
      signing_key_path: draft.signing_key_path.trim(),
      ...(draft.signing_algorithm ? { signing_algorithm: draft.signing_algorithm } : {}),
      ...common,
    };
  return undefined;
}
/** The secret the entry presents, by the key meka stores it under. */
function secret(draft: McpDraft) {
  if (draft.auth === 'token' && draft.auth_token.trim())
    return { auth_token: draft.auth_token.trim() };
  if (draft.auth === 'client_credentials' && draft.client_secret.trim())
    return { client_secret: draft.client_secret.trim() };
  return {};
}

/** The entry `POST /v1/mcp` adds, with the secret it presents beside it. Throws on a malformed
 * list, naming it. */
export function createMcpBody(draft: McpDraft): Schema['McpServerRequest'] {
  const http = draft.transport === 'http';
  const list = (text: string) => {
    const items = lines(text, true);
    return items.length ? items : undefined;
  };
  const env = http || !draft.env.trim() ? undefined : map(draft.env, '=', 'Environment');
  const headers = !http || !draft.headers.trim() ? undefined : map(draft.headers, ':', 'Headers');
  const toolPermissions = draft.tool_permissions.trim()
    ? map(draft.tool_permissions, '=', 'Tool permissions')
    : undefined;
  const entry = {
    name: draft.name.trim(),
    transport: draft.transport,
    ...(http
      ? {
          url: draft.url.trim(),
          ...(headers ? { headers } : {}),
          ...(draft.headers_helper.trim() ? { headers_helper: draft.headers_helper.trim() } : {}),
          ...(auth(draft) ? { auth: auth(draft) } : {}),
          ...secret(draft),
        }
      : {
          command: draft.command.trim(),
          ...(lines(draft.args).length ? { args: lines(draft.args) } : {}),
          ...(env ? { env } : {}),
        }),
    ...(draft.permission ? { permission: draft.permission } : {}),
    ...(list(draft.allowed_tools) ? { allowed_tools: list(draft.allowed_tools) } : {}),
    ...(list(draft.disabled_tools) ? { disabled_tools: list(draft.disabled_tools) } : {}),
    ...(list(draft.eager_load_tools) ? { eager_load_tools: list(draft.eager_load_tools) } : {}),
    ...(draft.deferral ? { deferral: draft.deferral } : {}),
    ...(toolPermissions ? { tool_permissions: toolPermissions } : {}),
    ...(draft.trust_read_only_hint
      ? { trust_read_only_hint: draft.trust_read_only_hint === 'true' }
      : {}),
    ...(draft.required ? { required: draft.required === 'true' } : {}),
    ...(draft.disabled ? { disabled: true } : {}),
  };
  return entry as Schema['McpServerRequest'];
}

/**
 * What an edit changed: each moved key's new value, `null` for one cleared. meka merges `env`,
 * `headers` and `tool_permissions` key by key, so each carries the keys set or changed, and
 * `null` for each taken out.
 */
export function patchMcpBody(initial: McpDraft, draft: McpDraft): Schema['PatchMcpServerRequest'] {
  const patch: Record<string, unknown> = {};
  const text = (key: 'command' | 'url' | 'permission' | 'headers_helper' | 'deferral') => {
    if (draft[key].trim() !== initial[key].trim()) patch[key] = draft[key].trim() || null;
  };
  const list = (
    key: 'args' | 'allowed_tools' | 'disabled_tools' | 'eager_load_tools',
    commas: boolean,
  ) => {
    const before = lines(initial[key], commas);
    const after = lines(draft[key], commas);
    if (before.join('\n') !== after.join('\n')) patch[key] = after.length ? after : null;
  };
  const flag = (key: 'trust_read_only_hint' | 'required') => {
    if (draft[key] !== initial[key]) patch[key] = draft[key] ? draft[key] === 'true' : null;
  };
  /** The keys entered and the kept keys taken out, as meka merges them. */
  const merged = (entered: Record<string, string>, kept: string[], before: string[]) => {
    const changes: Record<string, string | null> = { ...entered };
    for (const key of before) if (!kept.includes(key) && !(key in entered)) changes[key] = null;
    return Object.keys(changes).length ? changes : undefined;
  };
  if (draft.transport === 'stdio') {
    text('command');
    list('args', false);
    const env = merged(map(draft.env, '=', 'Environment'), draft.envKeys, initial.envKeys);
    if (env) patch.env = env;
  } else {
    text('url');
    text('headers_helper');
    const headers = merged(
      map(draft.headers, ':', 'Headers'),
      draft.headerKeys,
      initial.headerKeys,
    );
    if (headers) patch.headers = headers;
    const before = auth(initial);
    const after = auth(draft);
    if (JSON.stringify(before) !== JSON.stringify(after)) patch.auth = after ?? null;
    Object.assign(patch, secret(draft));
    // A secret the entry no longer presents would still be sent; leaving its kind removes it.
    if (initial.auth === 'token' && draft.auth !== 'token') patch.auth_token = null;
    if (initial.auth === 'client_credentials' && draft.auth !== 'client_credentials')
      patch.client_secret = null;
  }
  text('permission');
  list('allowed_tools', true);
  list('disabled_tools', true);
  list('eager_load_tools', true);
  text('deferral');
  const tools = map(draft.tool_permissions, '=', 'Tool permissions');
  const toolsBefore = map(initial.tool_permissions, '=', 'Tool permissions');
  const toolChanges: Record<string, string | null> = {};
  for (const [tool, level] of Object.entries(tools))
    if (toolsBefore[tool] !== level) toolChanges[tool] = level;
  for (const tool of Object.keys(toolsBefore)) if (!(tool in tools)) toolChanges[tool] = null;
  if (Object.keys(toolChanges).length) patch.tool_permissions = toolChanges;
  flag('trust_read_only_hint');
  flag('required');
  if (draft.disabled !== initial.disabled) patch.disabled = draft.disabled;
  return patch as Schema['PatchMcpServerRequest'];
}
