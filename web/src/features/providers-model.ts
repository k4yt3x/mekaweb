import type { Schema } from '../api/client';
import type { ProviderOrder } from '../connections/storage';

export const BACKENDS = [
  { id: 'anthropic-messages', label: 'Anthropic Messages API', subscription: false },
  { id: 'claude-subscription', label: 'Claude subscription', subscription: true },
  { id: 'openai-responses', label: 'OpenAI Responses API', subscription: false },
  { id: 'openai-chat-completions', label: 'OpenAI Chat Completions API', subscription: false },
  { id: 'chatgpt-subscription', label: 'ChatGPT subscription', subscription: true },
] as const;

export function backendLabel(backend: string | null | undefined) {
  return BACKENDS.find((entry) => entry.id === backend)?.label ?? backend ?? 'Unknown backend';
}
/** A subscription signs in through the browser; every other backend takes an API key. */
export function isSubscription(backend: string | null | undefined) {
  return BACKENDS.some((entry) => entry.id === backend && entry.subscription);
}

// meka 0.87.0: src/config.rs::Backend::reads_account_key and reads_profile_key. meka refuses a
// key the backend never reads, so the forms offer only these.
export function readsAccountKey(backend: string, key: string) {
  if (key === 'client_id' || key === 'oauth_token_url') return isSubscription(backend);
  if (key === 'interleaved_thinking') return backend === 'anthropic-messages';
  if (key === 'prompt_cache_key') return backend === 'openai-responses';
  if (key === 'stream_usage') return backend === 'openai-chat-completions';
  if (key === 'max_tool_name_bytes') return !isSubscription(backend);
  return true;
}
export function readsProfileKey(backend: string | null | undefined, key: string) {
  if (key === 'thinking_display') return backend === 'claude-subscription';
  if (key === 'thinking' || key === 'thinking_budget')
    return backend === 'anthropic-messages' || backend === 'claude-subscription';
  if (key === 'cache_control') return backend === 'anthropic-messages';
  if (key === 'encrypted_reasoning' || key === 'reasoning_summary')
    return backend === 'openai-responses';
  if (key === 'deferred_tools') return backend !== 'openai-chat-completions';
  return true;
}

/** A profile as its form holds it: every setting as entered, blank for one left to its default. */
export interface ProfileDraft {
  name: string;
  account: string;
  model: string;
  fallbacks: string[];
  makeDefault: boolean;
  context_window: string;
  max_output_tokens: string;
  max_request_bytes: string;
  effort: string;
  vision: string;
  deferred_tools: string;
  thinking: string;
  thinking_budget: string;
  cache_control: string;
  thinking_display: string;
  encrypted_reasoning: string;
  reasoning_summary: string;
}
const counts = [
  'context_window',
  'max_output_tokens',
  'max_request_bytes',
  'thinking_budget',
] as const;
const words = ['effort', 'deferred_tools', 'thinking', 'thinking_display'] as const;
const switches = ['vision', 'cache_control', 'encrypted_reasoning', 'reasoning_summary'] as const;
type Settings = Pick<
  Schema['PatchProfileRequest'],
  (typeof counts)[number] | (typeof words)[number] | (typeof switches)[number]
>;

export function profileDraft(profile?: Schema['ProfileDetailView']): ProfileDraft {
  const text = (value: string | number | boolean | null | undefined) =>
    value === null || value === undefined ? '' : String(value);
  return {
    name: profile?.name ?? '',
    account: profile?.account ?? '',
    model: profile?.model ?? '',
    fallbacks: profile?.fallbacks ?? [],
    makeDefault: profile?.active ?? false,
    context_window: text(profile?.context_window),
    max_output_tokens: text(profile?.max_output_tokens),
    max_request_bytes: text(profile?.max_request_bytes),
    effort: text(profile?.effort),
    vision: text(profile?.vision),
    deferred_tools: text(profile?.deferred_tools),
    thinking: text(profile?.thinking),
    thinking_budget: text(profile?.thinking_budget),
    cache_control: text(profile?.cache_control),
    thinking_display: text(profile?.thinking_display),
    encrypted_reasoning: text(profile?.encrypted_reasoning),
    reasoning_summary: text(profile?.reasoning_summary),
  };
}

/** The settings a draft states for `backend`, typed; one it leaves blank or the backend never
 * reads is absent. */
function settings(draft: ProfileDraft, backend: string | null | undefined): Settings {
  const stated: Settings = {};
  for (const key of counts)
    if (draft[key].trim() && readsProfileKey(backend, key)) stated[key] = Number(draft[key]);
  for (const key of words)
    if (draft[key].trim() && readsProfileKey(backend, key)) stated[key] = draft[key].trim();
  for (const key of switches)
    if (draft[key] && readsProfileKey(backend, key)) stated[key] = draft[key] === 'true';
  return stated;
}

export function createProfileBody(
  draft: ProfileDraft,
  backend: string | null | undefined,
): Schema['CreateProfileRequest'] {
  return {
    name: draft.name.trim(),
    account: draft.account,
    model: draft.model.trim(),
    ...(draft.fallbacks.length ? { fallbacks: draft.fallbacks } : {}),
    ...settings(draft, backend),
    ...(draft.makeDefault ? { default: true } : {}),
  };
}

/** What an edit changed: a new value for each setting that moved, `null` for one cleared. The
 * name is not in it, since meka takes a rename on its own. */
export function patchProfileBody(
  initial: ProfileDraft,
  draft: ProfileDraft,
  backend: string | null | undefined,
): Schema['PatchProfileRequest'] {
  const before = settings(initial, backend);
  const after = settings(draft, backend);
  const patch: Record<string, unknown> = {};
  for (const key of [...counts, ...words, ...switches])
    if (before[key] !== after[key]) patch[key] = after[key] ?? null;
  if (draft.model.trim() !== initial.model.trim()) patch.model = draft.model.trim();
  if (draft.fallbacks.join('\n') !== initial.fallbacks.join('\n'))
    patch.fallbacks = draft.fallbacks.length ? draft.fallbacks : null;
  if (draft.makeDefault && !initial.makeDefault) patch.default = true;
  return patch as Schema['PatchProfileRequest'];
}

export interface AccountDraft {
  name: string;
  backend: string;
  base_url: string;
  api_key: string;
  client_id: string;
  oauth_token_url: string;
  interleaved_thinking: string;
  prompt_cache_key: string;
  stream_usage: string;
  max_tool_name_bytes: string;
}
export function createAccountBody(draft: AccountDraft): Schema['CreateAccountRequest'] {
  const reads = (key: keyof AccountDraft) =>
    Boolean(draft[key].trim()) && readsAccountKey(draft.backend, key);
  const optional = (key: 'base_url' | 'client_id' | 'oauth_token_url') =>
    reads(key) ? { [key]: draft[key].trim() } : {};
  const toggle = (key: 'interleaved_thinking' | 'prompt_cache_key' | 'stream_usage') =>
    reads(key) ? { [key]: draft[key] === 'true' } : {};
  return {
    name: draft.name.trim(),
    backend: draft.backend,
    ...optional('base_url'),
    ...optional('client_id'),
    ...optional('oauth_token_url'),
    ...toggle('interleaved_thinking'),
    ...toggle('prompt_cache_key'),
    ...toggle('stream_usage'),
    ...(reads('max_tool_name_bytes')
      ? { max_tool_name_bytes: Number(draft.max_tool_name_bytes) }
      : {}),
    ...(isSubscription(draft.backend) ? {} : { api_key: draft.api_key.trim() }),
  };
}

/** An account and the profiles that run on it. */
export interface ProviderGroup {
  name: string;
  /** Absent where the account list does not name it: without config:r, or not configured. */
  account?: Schema['AccountView'];
  backend: string | null | undefined;
  profiles: Schema['ProfileView'][];
}
/**
 * Profiles under their accounts, in the order they were put in; an account or profile the order
 * does not name follows, in meka's order, and an account only a profile names comes after those.
 */
export function providerGroups(
  accounts: Schema['AccountView'][] | undefined,
  profiles: Schema['ProfileView'][],
  order: ProviderOrder = { accounts: [], profiles: [] },
): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>(
    (accounts ?? []).map((account) => [
      account.name,
      { name: account.name, account, backend: account.backend, profiles: [] },
    ]),
  );
  for (const profile of ranked(profiles, order.profiles)) {
    const group = groups.get(profile.account) ?? {
      name: profile.account,
      backend: profile.backend,
      profiles: [],
    };
    group.profiles.push(profile);
    groups.set(profile.account, group);
  }
  return ranked([...groups.values()], order.accounts);
}
/** Those `order` names first, as it has them, then the rest as they were. */
function ranked<T extends { name: string }>(items: T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((name, index) => [name, index]));
  const place = (item: T) => rank.get(item.name) ?? order.length;
  return [...items].sort((a, b) => place(a) - place(b));
}
/** The order with `from` renamed to `to`, so a renamed account or profile keeps its place. */
export function renameInOrder(
  order: ProviderOrder,
  kind: keyof ProviderOrder,
  from: string,
  to: string,
): ProviderOrder {
  return { ...order, [kind]: order[kind].map((name) => (name === from ? to : name)) };
}
