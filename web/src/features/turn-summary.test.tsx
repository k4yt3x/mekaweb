import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Schema } from '../api/client';
import { TurnSummary } from './turn-summary';

const turn: Schema['TurnRecord'] = {
  id: 'turn-1',
  source: 'client',
  started_at: '2026-10-23T10:26:41Z',
  ended_at: '2026-10-23T10:36:17Z',
  status: 'succeeded',
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 5,
  },
};

it('shows how a turn ended, as a control that opens its details', () => {
  const markup = renderToStaticMarkup(<TurnSummary turn={turn} />);
  expect(markup).toContain('class="turn-summary"');
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).toMatch(/Finished (at|on) .+ after 9m 36s/);
});

it('shows nothing for a turn still running', () => {
  expect(
    renderToStaticMarkup(<TurnSummary turn={{ ...turn, ended_at: null, status: null }} />),
  ).toBe('');
});
