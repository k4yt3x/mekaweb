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

it('does not treat inherited object names as registered event types', () => {
  expect(parseEvent({ event: 'constructor', data: '{}' })).toBeUndefined();
  expect(parseEvent({ event: '__proto__', data: '{}' })).toBeUndefined();
});
