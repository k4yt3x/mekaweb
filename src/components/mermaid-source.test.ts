import { expect, it } from 'vitest';
import { JSON_SCHEMA, load } from 'js-yaml';
import { prepareDiagram } from './mermaid-source';

it('accepts a Unicode title while leaving a plain diagram body intact', () => {
  const body = 'flowchart TB\n A["192.0.2.0/24<br/>文档用"]';
  const result = prepareDiagram(`---\ntitle: IPv4 特殊用途地址一览（2026）\n---\n${body}`);
  expect(result.title).toBe('IPv4 特殊用途地址一览（2026）');
  expect(result.source.endsWith(body)).toBe(true);
  expect(prepareDiagram(body)).toEqual({ source: body, title: undefined });
});

it('translates simple HTML label formatting into Mermaid’s SVG-safe Markdown strings', () => {
  expect(
    prepareDiagram('flowchart TB\n A["<b>192.0.2.0/24</b><br/>文档用"]\n B("<i>Test</i>")').source,
  ).toBe('flowchart TB\n A["`**192.0.2.0/24**<br/>文档用`"]\n B("`*Test*`")');
  expect(
    prepareDiagram('%% comment\ngraph LR\n A{"<strong>One<br/>Two</strong>"}').source,
  ).toContain('A{"`**One<br/>Two**`"}');
});

it.each([
  'graph TD\n A["<b>unclosed"]',
  'graph TD\n A["<b>wrong close</i>"]',
  'graph TD\n A["<span>unhandled HTML</span><b>bold</b>"]',
  'graph TD\n A["<b>Keep_literal_asterisks*</b>"]',
  'graph TD\n A["<b>[Keep link syntax literal](#target)</b>"]',
  'graph TD\n A["`<b>Existing Markdown</b>`"]',
  'sequenceDiagram\n Alice->>Bob: "<b>Message</b>"',
])('leaves other label syntaxes unchanged (%#)', (source) => {
  expect(prepareDiagram(source).source).toBe(source);
});

it('handles comments, quoted titles, multiline YAML, indentation, and CRLF', () => {
  expect(prepareDiagram('---\n# A title\ntitle: "IPv4: test"\n---\ngraph TD\n A --> B').title).toBe(
    'IPv4: test',
  );
  expect(prepareDiagram('\n  ---\n  title: >-\n    IPv4\n    timeline\n  ---\ngantt').title).toBe(
    'IPv4 timeline',
  );
  expect(prepareDiagram('---\r\ntitle: Test\r\n---\r\ngraph TD\r\n A --> B').title).toBe('Test');
  expect(prepareDiagram('---\n# No metadata\n---\ngraph TD').source).toBe('graph TD');
});

it('keeps text resembling configuration inside a multiline title', () => {
  const result = prepareDiagram(
    '---\ntitle: |-\n  Heading\n  ---\n  config:\n    securityLevel: loose\n---\ngraph TD\n A --> B',
  );
  const header = /^---\n(.*?)\n---\n/s.exec(result.source)![1]!;
  const metadata = load(header, { schema: JSON_SCHEMA });
  expect(metadata).toEqual({ title: 'Heading\n---\nconfig:\n  securityLevel: loose' });
});

it.each([
  'config:\n  securityLevel: loose',
  '"config":\n  themeCSS: body {}',
  'displayMode: compact',
  'title: [not, text]',
  'title: {config: unsafe}',
  'title: 123',
  'title: first\ntitle: second',
  '__proto__: {title: injected}',
  'title: !!js/function function() {}',
  '- title: array',
])('rejects unsupported or malformed frontmatter: %s', (header) => {
  expect(() => prepareDiagram(`---\n${header}\n---\ngraph TD\n A --> B`)).toThrow();
});

it.each([
  '---\ntitle: Missing delimiter\ngraph TD',
  '---\ntitle: Valid\n---\n%%{init: {"securityLevel": "loose"}}%%\ngraph TD',
  '---\ntitle: Valid\n---\n---\nconfig: {}\n---\ngraph TD',
  'graph TD\n A["https://example.test"]',
  'graph TD\n A@{ img: "resource.png" }',
  'graph TD\n classDef external fill:url(resource.svg)',
  'x'.repeat(20001),
])('retains directive and resource limits (%#)', (source) => {
  expect(() => prepareDiagram(source)).toThrow();
});
