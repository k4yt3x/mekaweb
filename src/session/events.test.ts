import { expect, it } from 'vitest';
import { parseEvent, SseParser, type SseFrame } from './events';
it('parses every transport boundary, CRLF, multiline data and transient events without inheriting ids', () => {
  const input =
    ': heartbeat\r\nretry: 3000\r\n\r\nid: 12\nevent: notice\ndata: {"text":\ndata: "hello"}\n\nevent: tool_call.output_delta\ndata: {"id":"tool","chunk":"output"}\n\n';
  for (let boundary = 0; boundary <= input.length; boundary++) {
    const frames: SseFrame[] = [];
    const retries: number[] = [];
    const parser = new SseParser(
      (f) => frames.push(f),
      (n) => retries.push(n),
    );
    parser.push(input.slice(0, boundary));
    parser.push(input.slice(boundary));
    expect(frames).toHaveLength(2);
    expect(frames[0]?.id).toBe('12');
    expect(frames[1]?.id).toBeUndefined();
    expect(retries).toEqual([3000]);
    expect(parseEvent(frames[0]!)).toEqual({ text: 'hello' });
  }
});
it('rejects malformed approval payloads and ignores unknown events', () => {
  expect(() =>
    parseEvent({
      event: 'permission_required',
      data: '{"request_id":"id","tool_name":"file_write"}',
    }),
  ).toThrow();
  expect(parseEvent({ event: 'future.event', data: '{}' })).toBeUndefined();
});

it('takes a background report only with the tasks it names', () => {
  const report = { task_ids: ['7f3a1c22-0000-4000-8000-000000000000'], text: 'ok' };
  expect(parseEvent({ event: 'task.reported', data: JSON.stringify(report) })).toEqual(report);
  expect(() =>
    parseEvent({ event: 'task.reported', data: '{"task_ids":[1],"text":"ok"}' }),
  ).toThrow();
  expect(() => parseEvent({ event: 'task.reported', data: '{"text":"ok"}' })).toThrow();
});

it('takes a tool result that loads deferred tools by reference, but only by name', () => {
  const completed = {
    id: 'toolu_1',
    is_error: false,
    content: [{ type: 'tool_reference', tool_name: 'mcp__docs__search' }],
  };
  expect(parseEvent({ event: 'tool_call.completed', data: JSON.stringify(completed) })).toEqual(
    completed,
  );
  expect(() =>
    parseEvent({
      event: 'tool_call.completed',
      data: '{"id":"toolu_1","is_error":false,"content":[{"type":"tool_reference"}]}',
    }),
  ).toThrow('Invalid tool result event.');
});

it('takes a turn’s opening only with typed blocks, and a deferral only with its items', () => {
  const opening = { turn_id: 't', role: 'user', content: [{ type: 'text', text: 'Hello.' }] };
  expect(parseEvent({ event: 'message.appended', data: JSON.stringify(opening) })).toEqual(opening);
  expect(() =>
    parseEvent({ event: 'message.appended', data: '{"role":"user","content":[{"text":"Hi"}]}' }),
  ).toThrow('Invalid message event.');
  expect(() => parseEvent({ event: 'message.appended', data: '{"content":[]}' })).toThrow();
  const deferral = {
    item_ids: ['item'],
    not_before: '2026-10-18T15:00:00Z',
    error: { title: 'Provider unavailable' },
  };
  expect(parseEvent({ event: 'inbox.deferred', data: JSON.stringify(deferral) })).toEqual(deferral);
  expect(() => parseEvent({ event: 'inbox.deferred', data: '{"not_before":"soon"}' })).toThrow(
    'Invalid delivery event.',
  );
});

it('does not treat inherited object names as registered event types', () => {
  expect(parseEvent({ event: 'constructor', data: '{}' })).toBeUndefined();
  expect(parseEvent({ event: '__proto__', data: '{}' })).toBeUndefined();
});

it('replaces an oversized tool completion with a note, keeping its call, id and correlation', () => {
  // meka writes id and is_error before content, and turn_id and session_id after it.
  const output = 'x'.repeat(1_500_000) + '"turn_id":"decoy" \\ ' + 'y'.repeat(1_500_000);
  const payload = JSON.stringify({
    id: 'toolu_1',
    is_error: true,
    content: [{ type: 'text', text: output }],
    turn_id: 'turn-1',
    session_id: 'session-1',
  });
  const input = `id: 7\nevent: tool_call.completed\ndata: ${payload}\n\nid: 8\nevent: notice\ndata: {"text":"after"}\n\n`;
  for (const size of [65_536, 1_000_003]) {
    const frames: SseFrame[] = [];
    const parser = new SseParser((frame) => frames.push(frame));
    for (let offset = 0; offset < input.length; offset += size)
      parser.push(input.slice(offset, offset + size));
    expect(frames.map((frame) => frame.id)).toEqual(['7', '8']);
    const completed = parseEvent(frames[0]!) as Record<string, unknown>;
    expect(completed).toMatchObject({
      id: 'toolu_1',
      is_error: true,
      turn_id: 'turn-1',
      session_id: 'session-1',
    });
    expect(JSON.stringify(completed.content)).toContain('too large to show while the turn runs');
    expect(frames[0]!.data.length).toBeLessThan(1000);
    expect(parseEvent(frames[1]!)).toEqual({ text: 'after' });
  }
});

it('keeps a short result whose change makes the completion oversized', () => {
  // meka 0.83 follows content with the whole text a call changed, before and after.
  const text = 'line "quoted" \\ ]}\n'.repeat(80_000);
  const result = [{ type: 'text', text: 'Edited lockfile.json: replaced 1 occurrence ]}' }];
  const payload = JSON.stringify({
    id: 'toolu_2',
    is_error: false,
    content: result,
    change: { path: 'lockfile.json', old: text, new: text + 'more' },
    turn_id: 'turn-2',
  });
  const frames: SseFrame[] = [];
  const parser = new SseParser((frame) => frames.push(frame));
  parser.push(`id: 4\nevent: tool_call.completed\ndata: ${payload}\n\n`);
  expect(payload.length).toBeGreaterThan(2_000_000);
  expect(parseEvent(frames[0]!)).toEqual({
    id: 'toolu_2',
    is_error: false,
    content: result,
    turn_id: 'turn-2',
  });
});

it('turns other oversized events into a notice that keeps the stream going', () => {
  const frames: SseFrame[] = [];
  const parser = new SseParser((frame) => frames.push(frame));
  parser.push(
    `id: 3\nevent: assistant_text.delta\ndata: {"text":"${'z'.repeat(2_100_000)}","turn_id":"t"}\n\n`,
  );
  expect(frames).toHaveLength(1);
  expect(frames[0]).toMatchObject({ id: '3', event: 'notice' });
  expect(parseEvent(frames[0]!)).toMatchObject({ level: 'warning', turn_id: 't' });
});

it('keeps fields that follow an oversized data line', () => {
  const frames: SseFrame[] = [];
  const parser = new SseParser((frame) => frames.push(frame));
  const text = 'q'.repeat(2_100_000);
  parser.push(
    `event: tool_call.completed\ndata: {"id":"tool","is_error":false,"content":[{"type":"text","text":"${text}"}],"turn_id":"t"}\nid: 9\n\n`,
  );
  expect(frames).toHaveLength(1);
  expect(frames[0]?.id).toBe('9');
  expect(parseEvent(frames[0]!)).toMatchObject({ id: 'tool', turn_id: 't' });
});
