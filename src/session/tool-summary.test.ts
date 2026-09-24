import { expect, it } from 'vitest';
import { toolSummary } from './tool-summary';

it('shows the command or path without including unrelated arguments', () => {
  const input = {
    command: 'cd ./vscode && ls -la',
    path: './config/settings.json',
    timeout_ms: 30000,
  };
  expect(toolSummary('shell_execute', input)).toBe(input.command);
  expect(toolSummary('file_read', input)).toBe(input.path);
  expect(toolSummary('execute_command', input)).toBe(input.command);
  expect(toolSummary('read_file', input)).toBe(input.path);
  expect(toolSummary('file_write', { path: 'config.json', content: 'file contents' })).toBe(
    'config.json',
  );
});

it('uses the server summary for live calls, including unknown tools and empty labels', () => {
  expect(toolSummary('shell_execute', { command: 'raw command' }, 'Resolved command')).toBe(
    'Resolved command',
  );
  expect(toolSummary('mcp__server__query', { secret: 'not a summary' }, 'Primary argument')).toBe(
    'Primary argument',
  );
  expect(toolSummary('file_read', { path: '/ignored' }, '')).toBeUndefined();
});

it('does not guess an unknown tool, absent argument, or non-scalar value', () => {
  expect(toolSummary('mcp__server__query', { query: 'not guessed' })).toBeUndefined();
  expect(toolSummary('file_read', { command: 'wrong key' })).toBeUndefined();
  expect(toolSummary('file_read', { path: { nested: 'object' } })).toBeUndefined();
  for (const input of [null, undefined, [], 'path'])
    expect(toolSummary('file_read', input)).toBeUndefined();
  for (const name of ['constructor', '__proto__', 'toString'])
    expect(toolSummary(name, { path: '/not a tool' })).toBeUndefined();
  expect(toolSummary('file_read', Object.create({ path: '/inherited' }))).toBeUndefined();
});

it('coerces scalar and list arguments like meka without serializing nested objects', () => {
  expect(toolSummary('conversation_read', { start: 0 })).toBe('0');
  expect(
    toolSummary('tool_load', { name: ['file_read', '', false, 3, null, {}, ['nested']] }),
  ).toBe('file_read, false, 3');
  expect(toolSummary('memory_search', { queries: ['workspace', 'project root'] })).toBe(
    'workspace, project root',
  );
  expect(toolSummary('mcp_resource_read', { server: 'server', uri: 'file:///workspace/a' })).toBe(
    'file:///workspace/a',
  );
  expect(toolSummary('tool_load', { name: [null, {}, []] })).toBeUndefined();
});

it('summarizes cancellation, task edits, and image inputs without displaying binary payloads', () => {
  expect(toolSummary('task_cancel', { id: 'task', all: true })).toBe('all');
  expect(toolSummary('task_cancel', { id: 'task', all: false })).toBe('task');
  expect(toolSummary('todo_edit', { set: { 2: 'done', 1: 'in_progress', 3: null } })).toBe(
    '#1 in_progress, #2 done',
  );
  expect(toolSummary('image_render', { from_scratchpad: 'frame', base64: 'opaque' })).toBe('frame');
  expect(toolSummary('image_render', { base64: 'opaque' })).toBe('<inline base64>');
  expect(toolSummary('image_render', {})).toBeUndefined();
  expect(toolSummary('todo', { title: 'Plan', items: [1] })).toBe('Plan');
  expect(toolSummary('todo', { items: [1] })).toBe('1 task');
  expect(toolSummary('todo', {})).toBe('read');
});

it('flattens header text while preserving the original input and readable Unicode', () => {
  const input = Object.freeze({ command: '  cd ./工程\n\t&& echo café 👩‍💻\u0000\u202e  ' });
  const before = JSON.stringify(input);
  expect(toolSummary('shell_execute', input)).toBe('cd ./工程 && echo café 👩‍💻');
  expect(JSON.stringify(input)).toBe(before);
  expect(toolSummary('file_read', { path: ' \n\t' })).toBeUndefined();
});

it('bounds long previews with both ends retained and no broken Unicode characters', () => {
  const command = 'prefix/' + '工程📁'.repeat(4000) + '/settings.json';
  const summary = toolSummary('file_read', { path: command })!;
  expect(Array.from(summary)).toHaveLength(1024);
  expect(summary).toMatch(/^prefix\//);
  expect(summary).toMatch(/…/);
  expect(summary.endsWith('/settings.json')).toBe(true);
  expect(/[\p{Cs}]/u.test(summary)).toBe(false);
});
