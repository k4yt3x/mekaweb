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
  expect(toolSummary('unknown_tool', { query: 'not guessed' })).toBeUndefined();
  expect(toolSummary('mcp__server', { query: 'no tool named' })).toBeUndefined();
  expect(toolSummary('file_read', { command: 'wrong key' })).toBeUndefined();
  expect(toolSummary('file_read', { path: { nested: 'object' } })).toBeUndefined();
  for (const input of [null, undefined, [], 'path'])
    expect(toolSummary('file_read', input)).toBeUndefined();
  for (const name of ['constructor', '__proto__', 'toString'])
    expect(toolSummary(name, { path: '/not a tool' })).toBeUndefined();
  expect(toolSummary('file_read', Object.create({ path: '/inherited' }))).toBeUndefined();
});

// Meka 0.88.0: src/tools.rs::an_mcp_call_is_shown_by_its_first_argument_that_reads_as_text.
it('shows an MCP call by its first argument that is text, else its first that reads as text', () => {
  const shown = (input: unknown) => toolSummary('mcp__exa__web_search_exa', input);
  expect(shown({ query: 'ratatui', numResults: 5 })).toBe('ratatui');
  // A number or a flag ahead of the text is not what the call is for.
  expect(shown({ limit: 10, recursive: true, query: 'rust' })).toBe('rust');
  // An object has no short form, so the next argument is taken.
  expect(shown({ options: { deep: true }, query: 'ratatui' })).toBe('ratatui');
  expect(shown({ query: '', urls: ['https://a.example', 'https://b.example'] })).toBe(
    'https://a.example, https://b.example',
  );
  expect(shown({ count: 42 })).toBe('42');
  expect(shown({ config: { nested: 1 } })).toBeUndefined();
  expect(shown({})).toBeUndefined();
  // Meka's own arguments and a blank one are not the call's to be shown by.
  expect(shown({ background: true, scratchpad: 'results', query: '  ', topic: 'ratatui' })).toBe(
    'ratatui',
  );
  // A tool's own `background`, which is no flag, is its argument.
  expect(shown({ background: '#fff' })).toBe('#fff');
});

it('coerces scalar and list arguments like Meka without serializing nested objects', () => {
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
  expect(toolSummary('checklist_edit', { id: 2, status: 'completed' })).toBe('#2 completed');
  expect(toolSummary('checklist_edit', { id: 2, text: 'Reworded' })).toBe('#2');
  expect(toolSummary('checklist_edit', {})).toBeUndefined();
  expect(toolSummary('checklist_add', { items: ['one', { text: 'two' }] })).toBe('one');
  expect(toolSummary('checklist_read', {})).toBeUndefined();
  expect(toolSummary('image_render', { from_scratchpad: 'frame', base64: 'opaque' })).toBe('frame');
  expect(toolSummary('image_render', { base64: 'opaque' })).toBe('<inline base64>');
  expect(toolSummary('image_render', {})).toBeUndefined();
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
