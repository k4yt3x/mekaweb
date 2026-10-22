import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Markdown } from './markdown';

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

it('renders labeled, read-only task markers through the shared checkbox primitive', () => {
  const html = render('- [x] **Finished** item\n- [ ] Pending item\n  - [x] Nested item');
  const inputs = html.match(/<input\b[^>]*>/g) ?? [];
  expect(inputs).toHaveLength(3);
  expect(inputs[0]).toContain('aria-label="Finished item"');
  expect(inputs[1]).toContain('aria-label="Pending item"');
  expect(inputs[2]).toContain('aria-label="Nested item"');
  for (const input of inputs) {
    expect(input).toContain('class="checkbox-input"');
    expect(input).toContain('disabled=""');
  }
  expect(inputs[0]).toContain('checked=""');
  expect(inputs[1]).not.toContain('checked=""');
  expect(inputs[2]).toContain('checked=""');
  expect(render('```html\n<input type="checkbox">\n```')).not.toContain('class="checkbox-input"');
});

it('renders bold Chinese list labels ending in punctuation without requiring extra spaces', () => {
  const labels = [
    '最低保障：加拿大更厚。',
    '和工资的关系：美国更强。',
    '家庭结构：美国的配偶福利对只有一人工作的家庭更有利。',
    '医疗开支：',
  ];
  const html = render(
    labels.map((label, index) => `${index + 1}. **${label}**继续说明。`).join('\n'),
  );
  expect(html).toContain('<ol>');
  for (const label of labels)
    expect(html).toContain(`<li><strong>${label}</strong>继续说明。</li>`);
  expect(html).not.toContain('**');
});

it.each([
  ['中文**（重点）**继续', '中文<strong>（重点）</strong>继续'],
  ['これは**「重要」**です。', 'これは<strong>「重要」</strong>です。'],
  ['이것은 **중요(확인)**입니다.', '이것은 <strong>중요(확인)</strong>입니다.'],
  ['𠮷**「字」**𠮷', '𠮷<strong>「字」</strong>𠮷'],
  ['中文*（斜体）*继续', '中文<em>（斜体）</em>继续'],
])('recognizes emphasis beside CJK punctuation: %s', (source, expected) => {
  expect(render(source)).toContain(`<p>${expected}</p>`);
});

it('keeps nested emphasis, inline code, and links inside the intended bold span', () => {
  const html = render('**先看*（重点）*，用 `x ** y`，再读[说明](https://example.invalid)。**继续');
  expect(html).toContain('<strong>先看<em>（重点）</em>，用 <code>x ** y</code>，再读<a');
  expect(html).toContain('href="https://example.invalid"');
  expect(html).toContain('说明</a>。</strong>继续');
});

it.each([
  ['`**医疗开支：**加拿大`', '<code>**医疗开支：**加拿大</code>'],
  ['```text\n**医疗开支：**加拿大\n```', '**医疗开支：**加拿大</code>'],
  ['    **医疗开支：**加拿大', '**医疗开支：**加拿大</code>'],
  [String.raw`\*\*医疗开支：\*\*加拿大`, '<p>**医疗开支：**加拿大</p>'],
  ['**医疗开支：', '<p>**医疗开支：</p>'],
])('keeps literal and unfinished Markdown intact: %s', (source, expected) => {
  const html = render(source);
  expect(html).toContain(expected);
  expect(html).not.toContain('<strong>');
});

it('keeps completed bold text bold as adjacent Chinese text streams in', () => {
  const bold = '**医疗开支：**';
  const following = '加拿大退休人员';
  for (let length = 0; length <= following.length; length++) {
    expect(render(bold + following.slice(0, length))).toContain(
      `<p><strong>医疗开支：</strong>${following.slice(0, length)}</p>`,
    );
  }
});

it('retains ordinary CommonMark emphasis and literal delimiters outside CJK text', () => {
  const html = render(
    '**bold** and *italic* and ***both***; foo_bar_baz; **bold.**word; **US$202.90**/月',
  );
  expect(html).toContain(
    '<strong>bold</strong> and <em>italic</em> and <em><strong>both</strong></em>',
  );
  expect(html).toContain('foo_bar_baz; **bold.**word; <strong>US$202.90</strong>/月');
});

it('composes with tables, math, admonitions, and the existing HTML and URL restrictions', () => {
  const html = render(
    [
      '| 项目 | 说明 |',
      '| --- | --- |',
      '| 标签 | **医疗开支：**加拿大 |',
      '',
      '> [!NOTE]',
      '> **注意：**保留 $x^2$。',
      '',
      '**注意：**<script>alert(1)</script>[链接](javascript:alert%281%29)',
    ].join('\n'),
  );
  expect(html).toContain('<strong>医疗开支：</strong>加拿大</td>');
  expect(html).toContain('markdown-alert-note');
  expect(html).toContain('class="katex"');
  expect(html).toContain('<strong>注意：</strong>');
  expect(html).not.toMatch(/<script|javascript:/);
});
