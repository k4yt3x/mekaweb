import { expect, it } from 'vitest';
import {
  createAccountBody,
  createProfileBody,
  patchProfileBody,
  profileDraft,
  readsProfileKey,
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
    active: true,
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
