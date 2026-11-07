import { expect, it } from 'vitest';
import {
  createAccountBody,
  createProfileBody,
  parametersProblem,
  patchProfileBody,
  profileDraft,
  providerGroups,
  readsProfileKey,
  renameInOrder,
} from './providers-model';

it('offers each profile setting only where meka sends it', () => {
  expect(readsProfileKey('claude-subscription', 'thinking_display')).toBe(true);
  expect(readsProfileKey('anthropic-messages', 'thinking_display')).toBe(false);
  expect(readsProfileKey('anthropic-messages', 'cache_control')).toBe(true);
  expect(readsProfileKey('claude-subscription', 'cache_control')).toBe(false);
  expect(readsProfileKey('openai-responses', 'thinking')).toBe(false);
  expect(readsProfileKey('openai-chat-completions', 'deferred_tools')).toBe(false);
  expect(readsProfileKey('openai-chat-completions', 'effort')).toBe(true);
  expect(readsProfileKey('openai-responses', 'encrypted_reasoning')).toBe(true);
  expect(readsProfileKey('chatgpt-subscription', 'reasoning_summary')).toBe(false);
  expect(readsProfileKey('chatgpt-subscription', 'cyber_access_program')).toBe(true);
  expect(readsProfileKey('openai-responses', 'cyber_access_program')).toBe(false);
  expect(readsProfileKey('openai-chat-completions', 'parameters')).toBe(true);
  expect(readsProfileKey('claude-subscription', 'parameters')).toBe(false);
  expect(readsProfileKey('chatgpt-subscription', 'parameters')).toBe(false);
});

it('sends request parameters as the JSON object typed, and Daybreak where it is read', () => {
  const draft = {
    ...profileDraft(),
    name: 'qwen',
    account: 'openrouter',
    model: 'qwen/qwen3-235b-a22b',
    parameters: '{"temperature": 0.6, "provider": {"order": ["deepinfra"]}}',
    cyber_access_program: 'daybreak_blue',
  };
  expect(createProfileBody(draft, 'openai-chat-completions')).toMatchObject({
    parameters: { temperature: 0.6, provider: { order: ['deepinfra'] } },
  });
  expect(createProfileBody(draft, 'openai-chat-completions')).not.toHaveProperty(
    'cyber_access_program',
  );
  // A subscription reads no parameters, and ChatGPT's takes its program.
  expect(createProfileBody(draft, 'chatgpt-subscription')).toMatchObject({
    cyber_access_program: 'daybreak_blue',
  });
  expect(createProfileBody(draft, 'chatgpt-subscription')).not.toHaveProperty('parameters');
  for (const text of ['[1]', '0.6', 'null', '{temperature: 0.6}'])
    expect(() => createProfileBody({ ...draft, parameters: text }, 'openai-responses')).toThrow(
      'Request parameters: Write a JSON object',
    );
  expect(parametersProblem('  ')).toBeUndefined();
  expect(parametersProblem('{}')).toBeUndefined();
  expect(parametersProblem('{')).toBe('Write a JSON object, such as {"temperature": 0.6}.');
});

it('patches request parameters whole when what they say changes, and clears them with null', () => {
  const start = profileDraft({
    name: 'qwen',
    account: 'openrouter',
    model: 'qwen/qwen3-235b-a22b',
    default: false,
    parameters: { temperature: 0.6 },
  });
  expect(start.parameters).toBe('{\n  "temperature": 0.6\n}');
  const backend = 'openai-chat-completions';
  expect(patchProfileBody(start, { ...start, parameters: '{"temperature":0.6}' }, backend)).toEqual(
    {},
  );
  expect(
    patchProfileBody(start, { ...start, parameters: '{"temperature": 0.6, "top_p": 1}' }, backend),
  ).toEqual({ parameters: { temperature: 0.6, top_p: 1 } });
  expect(patchProfileBody(start, { ...start, parameters: '' }, backend)).toEqual({
    parameters: null,
  });
});

it('adds a profile with what it states, typed, and drops what its backend never sends', () => {
  const draft = {
    ...profileDraft(),
    name: ' work ',
    account: 'openai',
    model: 'gpt-6-astra',
    context_window: '131072',
    vision: 'false',
    thinking: 'off',
    cache_control: 'true',
    makeDefault: true,
  };
  expect(createProfileBody(draft, 'openai-responses')).toEqual({
    name: 'work',
    account: 'openai',
    model: 'gpt-6-astra',
    context_window: 131072,
    vision: false,
    default: true,
  });
});

it('patches only what moved, clears with null, and leaves the name to a rename', () => {
  const start = profileDraft({
    name: 'main',
    account: 'anthropic',
    model: 'claude-opus-5-5',
    fallbacks: ['backup'],
    default: true,
    effort: 'high',
    thinking: 'adaptive',
  });
  expect(patchProfileBody(start, { ...start, name: 'renamed' }, 'anthropic-messages')).toEqual({});
  expect(
    patchProfileBody(
      start,
      { ...start, effort: '', thinking: 'budgeted', thinking_budget: '20000', fallbacks: [] },
      'anthropic-messages',
    ),
  ).toEqual({ effort: null, thinking: 'budgeted', thinking_budget: 20000, fallbacks: null });
  const other = { ...start, makeDefault: false };
  expect(patchProfileBody(other, { ...other, makeDefault: true }, 'anthropic-messages')).toEqual({
    default: true,
  });
});

it('adds an account with a key only where the backend takes one', () => {
  const draft = {
    name: 'claude',
    backend: 'claude-subscription',
    base_url: '',
    api_key: 'ignored',
    client_id: ' custom ',
    oauth_token_url: '',
    interleaved_thinking: 'false',
    prompt_cache_key: 'false',
    stream_usage: 'false',
    max_tool_name_bytes: '64',
  };
  expect(createAccountBody(draft)).toEqual({
    name: 'claude',
    backend: 'claude-subscription',
    client_id: 'custom',
  });
  expect(
    createAccountBody({
      ...draft,
      backend: 'anthropic-messages',
      api_key: ' sk-1 ',
      client_id: '',
    }),
  ).toEqual({
    name: 'claude',
    backend: 'anthropic-messages',
    interleaved_thinking: false,
    max_tool_name_bytes: 64,
    api_key: 'sk-1',
  });
  expect(
    createAccountBody({ ...draft, backend: 'openai-responses', api_key: 'sk-2', client_id: '' }),
  ).toEqual({
    name: 'claude',
    backend: 'openai-responses',
    prompt_cache_key: false,
    max_tool_name_bytes: 64,
    api_key: 'sk-2',
  });
});

it('lists profiles under their accounts, and an account only a profile names after the rest', () => {
  const account = (name: string) => ({ name, backend: 'anthropic-messages', authenticated: 'yes' });
  const profile = (name: string, on: string) => ({
    name,
    account: on,
    backend: 'anthropic-messages',
    default: false,
    vision: true,
  });
  const groups = providerGroups(
    [account('work'), account('spare')],
    [profile('a', 'gone'), profile('b', 'work'), profile('c', 'work')],
  );
  expect(groups.map((group) => [group.name, group.profiles.map((p) => p.name)])).toEqual([
    ['work', ['b', 'c']],
    ['spare', []],
    ['gone', ['a']],
  ]);
  expect(groups[2]?.account).toBeUndefined();
  expect(providerGroups(undefined, [profile('a', 'work')])[0]?.backend).toBe('anthropic-messages');
});

it('puts accounts and profiles in the order given, with ones it does not name after', () => {
  const account = (name: string) => ({ name, backend: 'anthropic-messages', authenticated: 'yes' });
  const profile = (name: string, on: string) => ({
    name,
    account: on,
    backend: 'anthropic-messages',
    default: false,
    vision: true,
  });
  const groups = providerGroups(
    [account('a'), account('b'), account('c')],
    [profile('a1', 'a'), profile('a2', 'a'), profile('a3', 'a'), profile('c1', 'c')],
    { accounts: ['c', 'gone', 'a'], profiles: ['a3', 'a1'] },
  );
  expect(groups.map((group) => [group.name, group.profiles.map((p) => p.name)])).toEqual([
    ['c', ['c1']],
    ['a', ['a3', 'a1', 'a2']],
    ['b', []],
  ]);
  expect(
    renameInOrder({ accounts: ['a'], profiles: ['a3', 'a1'] }, 'profiles', 'a1', 'first'),
  ).toEqual({ accounts: ['a'], profiles: ['a3', 'first'] });
});
