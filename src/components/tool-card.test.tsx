import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ToolCard } from './tool-card';

it('shows the primary argument in the heading while retaining full arguments and results', () => {
  const html = renderToStaticMarkup(
    <ToolCard
      name="shell_execute"
      input={{ command: 'pwd', timeout_ms: 30000 }}
      status="Completed"
      isError={false}
    >
      <p>Tool result</p>
    </ToolCard>,
  );
  expect(html).toContain('<code>pwd</code>');
  expect(html).toContain('timeout_ms');
  expect(html).toContain('30000');
  expect(html).toContain('<p>Tool result</p>');
  expect(html).toContain('Completed');
});

it('renders server summaries as text rather than markup or Markdown', () => {
  const html = renderToStaticMarkup(
    <ToolCard
      name="mcp__server__query"
      input={{ hidden: 'another argument' }}
      displaySummary={'<img src=x onerror=alert(1)> **plain**'}
      status="Running"
      isError={false}
    >
      {null}
    </ToolCard>,
  );
  expect(html).toContain('&lt;img');
  expect(html).toContain('**plain**');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<strong>');
});

it('keeps unknown and argument-free tools bare and preserves their error state', () => {
  const html = renderToStaticMarkup(
    <ToolCard name="unknown_tool" input={{ path: '/not guessed' }} status="Error" isError>
      {null}
    </ToolCard>,
  );
  expect(html).not.toContain('tool-argument');
  expect(html).toContain('tool-error');
  expect(html).toContain('unknown_tool');
  expect(html).toContain('Error');
});
