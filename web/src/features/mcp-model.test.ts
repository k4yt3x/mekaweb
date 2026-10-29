import { expect, it } from 'vitest';
import { createMcpBody, mcpDraft, pairs, patchMcpBody } from './mcp-model';

it('reads KEY=value and Name: value lines, naming the first that is neither', () => {
  expect(pairs('A=1\n\n B = two=2 ', '=')).toEqual({ A: '1', B: 'two=2' });
  expect(pairs('Authorization: Bearer x', ':')).toEqual({ Authorization: 'Bearer x' });
  expect(pairs('A=1\nbroken', '=')).toBe('broken');
});

it('adds a command server with its arguments and environment', () => {
  const draft = {
    ...mcpDraft(),
    name: 'files',
    command: 'npx',
    args: '-y\n@modelcontextprotocol/server-filesystem\n/tmp',
    env: 'DEBUG=1',
    url: 'ignored',
    permission: 'read',
    eager_load_tools: 'read_file, list_directory',
  };
  expect(createMcpBody(draft)).toEqual({
    name: 'files',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    env: { DEBUG: '1' },
    permission: 'read',
    eager_load_tools: ['read_file', 'list_directory'],
  });
  expect(() => createMcpBody({ ...draft, env: 'DEBUG' })).toThrow('Environment');
});

it('adds an HTTP server with its sign-in and the secret beside it', () => {
  const draft = {
    ...mcpDraft(),
    name: 'api',
    transport: 'http' as const,
    url: 'https://api.example.com/mcp',
    auth: 'client_credentials' as const,
    client_id: 'meka',
    client_secret: 's3cret',
    scopes: 'read, write',
  };
  expect(createMcpBody(draft)).toEqual({
    name: 'api',
    transport: 'http',
    url: 'https://api.example.com/mcp',
    auth: { type: 'client_credentials', client_id: 'meka', scopes: ['read', 'write'] },
    client_secret: 's3cret',
  });
  expect(createMcpBody({ ...draft, auth: 'token', auth_token: 'tok' })).toEqual({
    name: 'api',
    transport: 'http',
    url: 'https://api.example.com/mcp',
    auth_token: 'tok',
  });
});

it('patches what moved, merging environment and tool permissions key by key', () => {
  const start = mcpDraft({
    name: 'files',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'server'],
    required: false,
    deferral: 'deferred',
    inherited: ['deferral'],
    disabled: false,
    permission: 'read',
    env_keys: ['TOKEN', 'DEBUG'],
    tool_permissions: { write: 'workspace', read: 'read' },
  });
  expect(start).toMatchObject({ required: 'false', deferral: '', envKeys: ['TOKEN', 'DEBUG'] });
  expect(patchMcpBody(start, start)).toEqual({});
  expect(
    patchMcpBody(start, {
      ...start,
      permission: '',
      args: '',
      env: 'TOKEN=new',
      envKeys: ['TOKEN'],
      tool_permissions: 'write=unrestricted',
      required: '',
      deferral: 'eager',
      disabled: true,
    }),
  ).toEqual({
    permission: null,
    args: null,
    env: { TOKEN: 'new', DEBUG: null },
    tool_permissions: { write: 'unrestricted', read: null },
    required: null,
    deferral: 'eager',
    disabled: true,
  });
});

it('edits an HTTP server’s sign-in by its whole block, keeping a stored secret unless replaced', () => {
  const start = mcpDraft({
    name: 'api',
    transport: 'http',
    url: 'https://api.example.com/mcp',
    required: false,
    deferral: 'deferred',
    inherited: ['required', 'deferral'],
    disabled: false,
    auth: { type: 'client_credentials', client_id: 'meka', scopes: ['read'] },
    credentials: ['client secret'],
  });
  expect(start).toMatchObject({ auth: 'client_credentials', client_id: 'meka', scopes: 'read' });
  expect(patchMcpBody(start, { ...start, scopes: 'read, write' })).toEqual({
    auth: { type: 'client_credentials', client_id: 'meka', scopes: ['read', 'write'] },
  });
  expect(patchMcpBody(start, { ...start, client_secret: 'rotated' })).toEqual({
    client_secret: 'rotated',
  });
  expect(patchMcpBody(start, { ...start, auth: '' })).toEqual({ auth: null, client_secret: null });
  const bearer = mcpDraft({
    name: 'api',
    transport: 'http',
    url: 'https://api.example.com/mcp',
    required: false,
    deferral: 'deferred',
    disabled: false,
    credentials: ['bearer token'],
  });
  expect(bearer.auth).toBe('token');
  expect(patchMcpBody(bearer, { ...bearer, auth: '' })).toEqual({ auth_token: null });
});
