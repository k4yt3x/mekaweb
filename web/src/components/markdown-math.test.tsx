import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './markdown';

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'" };

/**
 * The HTML of `text` with each formula as `⟨TeX⟩`, or `⟦TeX⟧` in display mode, and `!` after a
 * formula KaTeX marked a command of in red.
 */
function view(text: string): string {
  let html = renderToStaticMarkup(<Markdown text={text} />);
  for (;;) {
    const display = html.indexOf('<span class="katex-display"');
    const inline = html.indexOf('<span class="katex"');
    const start = display !== -1 && (inline === -1 || display < inline) ? display : inline;
    if (start === -1) return html;
    const tags = /<span\b|<\/span>/g;
    tags.lastIndex = start;
    let depth = 0;
    let end = start;
    for (let tag; (tag = tags.exec(html));) {
      depth += tag[0] === '</span>' ? -1 : 1;
      if (!depth) {
        end = tags.lastIndex;
        break;
      }
    }
    const formula = html.slice(start, end);
    const tex = /<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/
      .exec(formula)![1]!
      .replace(/&(amp|lt|gt|quot|#x27);/g, (_match, name: string) => entities[name]!);
    const red = formula.includes('color:var(--danger)') ? '!' : '';
    html =
      html.slice(0, start) + (start === display ? `⟦${tex}⟧` : `⟨${tex}⟩`) + red + html.slice(end);
  }
}

describe('prose', () => {
  it('keeps prices, variables, and escaped dollars as text', () => {
    const prices = view(
      'Two **DGX Sparks (about $13.9k)** give 57 tok/s. A **Mac Studio (about $5.4–5.9k)** is ' +
        'cheaper; four GPUs cost about $75k.',
    );
    expect(prices).not.toMatch(/[⟨⟦]/);
    expect(prices).toContain('<strong>DGX Sparks (about $13.9k)</strong>');
    expect(prices).toContain('<strong>Mac Studio (about $5.4–5.9k)</strong>');
    for (const text of [
      'From $5–$10, or $1,000 and $2,000.',
      'US$5, 5$ or C$10.',
      'Set $HOME and $PATH, or $HOME/$USER and $PATH:$HOME.',
      'Use ${name} and ${value}.',
      'Costs \\$5 and \\$10.',
      '$$$ rich.',
    ])
      expect(view(text), text).not.toMatch(/[⟨⟦]/);
  });

  it('keeps escaped brackets as text', () => {
    expect(view('See \\[1\\], array\\[0\\], \\[link\\], and \\[ \\].')).toContain(
      '<p>See [1], array[0], [link], and [ ].</p>',
    );
    expect(view('\\[1\\] Smith, 2020.')).toContain('<p>[1] Smith, 2020.</p>');
  });

  it('keeps math delimiters in code and links as written', () => {
    expect(view('Run `echo $HOME` and `$x$` and `\\(y\\)`.')).not.toMatch(/[⟨⟦]/);
    expect(view('```\n\\[x\\]\n$$\ny\n$$\n```')).not.toMatch(/[⟨⟦]/);
    expect(view('Code:\n\n    $$\n    x\n    $$')).not.toMatch(/[⟨⟦]/);
    const links = view(
      '[Foo](https://w.org/Foo_\\(bar\\)), https://x.com/?a=$5&b=$6, <https://x/$a$>',
    );
    expect(links).not.toMatch(/[⟨⟦]/);
    expect(links).toContain('href="https://w.org/Foo_(bar)"');
  });
});

describe('inline math', () => {
  it('reads single dollars as Pandoc does, so the next `$` closes them', () => {
    expect(view('Let $x^2$ and $\\frac{a}{b}$ be.')).toContain('Let ⟨x^2⟩ and ⟨\\frac{a}{b}⟩ be.');
    expect(view("The $n$th, $k$-th, and $x$'s.")).toContain('The ⟨n⟩th, ⟨k⟩-th, and ⟨x⟩&#x27;s.');
    expect(view('At $5 each, $n$ cost $5n$.')).toContain('At $5 each, ⟨n⟩ cost ⟨5n⟩.');
    expect(view('设$x$为实数，$y$。')).toContain('设⟨x⟩为实数，⟨y⟩。');
    expect(view('Total $\\$5 + \\$3$.')).toContain('⟨\\$5 + \\$3⟩');
    expect(view('A $a +\nb$ c')).toContain('⟨a +\nb⟩');
    expect(view('**$x$ is** *$y$*')).toContain('<strong>⟨x⟩ is</strong> <em>⟨y⟩</em>');
    expect(view('Spaced $ \\alpha $ is math; $ x $ is not.')).toContain(
      'Spaced ⟨ \\alpha ⟩ is math; $ x $ is not.',
    );
  });

  it('reads `\\(` and `\\)` as inline math, and `$$` within a line too', () => {
    expect(view('where \\(x\\) and \\( y^2 \\) are real')).toContain('where ⟨x⟩ and ⟨ y^2 ⟩ are');
    expect(view('So $$E = mc^2$$ holds.')).toContain('So ⟨E = mc^2⟩ holds.');
    expect(view('- Outer\n    - Inner \\(x^2\\) here')).toContain('Inner ⟨x^2⟩ here');
    expect(view('## About $x$ and \\(y\\)')).toContain('<h2>About ⟨x⟩ and ⟨y⟩</h2>');
  });
});

describe('display math', () => {
  it('reads every way models delimit it', () => {
    for (const [text, tex] of [
      ['$$\nE = mc^2\n$$', 'E = mc^2'],
      ['$$E = mc^2$$', 'E = mc^2'],
      ['$$\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}$$', '\\begin{aligned}'],
      ['$$ x = 1\n+ 2 $$', 'x = 1\n+ 2'],
      ['\\[\nE = mc^2\n\\]', 'E = mc^2'],
      ['\\[ E = mc^2 \\]', 'E = mc^2'],
      ['\\[ x = 1 +\n2 \\]', 'x = 1 +\n2'],
      ['\\begin{align*}\na &= b \\\\\nc &= d\n\\end{align*}', '\\begin{align*}'],
      ['```math\nx^2 + y^2\n```', 'x^2 + y^2'],
      ['$$\r\nx = 1\r\n$$', 'x = 1'],
    ]) {
      const html = view(`Before\n\n${text}\n\nAfter **bold**`);
      expect(html, text).toContain(`⟦${tex}`);
      expect(html, text).toMatch(/⟧\s*<p>After <strong>bold<\/strong><\/p>/);
    }
  });

  it('holds lines that would otherwise be Markdown', () => {
    expect(view('$$\nx^2\n- 4ac\n$$\n\nAfter')).toContain('⟦x^2\n- 4ac⟧');
    expect(view('\\[\na\n\n> b\n\\]')).toContain('⟦a\n\n> b⟧');
  });

  it('ends a paragraph at math on its own line', () => {
    expect(view('We get\n$$\nx = 1\n$$\nso done.')).toMatch(
      /<p>We get<\/p>\s*⟦x = 1⟧\s*<p>so done/,
    );
    expect(view('Value:\n$$x=1$$\nand more')).toMatch(/<p>Value:<\/p>\s*⟦x=1⟧\s*<p>and more/);
    expect(view('We get\n$$\\begin{aligned}\na &= b\n\\end{aligned}$$')).toMatch(
      /<p>We get<\/p>\s*⟦\\begin\{aligned\}/,
    );
    expect(view('In bash\n$$ is the PID.')).toContain('<p>In bash\n$$ is the PID.</p>');
  });

  it('sets `\\[` within prose, and `$$` across lines, as display math', () => {
    expect(view('So \\[E = mc^2\\] holds.')).toContain('<p>So ⟦E = mc^2⟧ holds.</p>');
    expect(view('$$\n\\begin{aligned}\na &= b\n\\end{aligned}$$, where $a$ is real.')).toMatch(
      /⟦\s*\\begin\{aligned\}[^⟧]*⟧, where ⟨a⟩ is real\./,
    );
  });

  it('stays within lists and quotes', () => {
    const list = view('1. Compute:\n   \\[\n   x = 1\n   \\]\n2. Next **step**');
    expect(list).toMatch(/<ol>\s*<li>Compute:\s*⟦x = 1⟧\s*<\/li>\s*<li>Next <strong>step/);
    expect(view('- Outer\n    - Inner:\n      \\[\n      x = 1\n      \\]\n    - After')).toMatch(
      /<li>Inner:\s*⟦x = 1⟧\s*<\/li>\s*<li>After<\/li>/,
    );
    expect(view('1. Step\n   \\[\n   x\n\\]\n2. Next')).toMatch(
      /<li>Step\s*⟦x⟧\s*<\/li>\s*<li>Next/,
    );
    expect(view('> Note:\n> $$\n> x = 1\n> $$\n\nAfter')).toMatch(
      /<blockquote>\s*<p>Note:<\/p>\s*⟦x = 1⟧\s*<\/blockquote>\s*<p>After/,
    );
    expect(view('1. \\[ x = 1 \\]\n2. $$y = 2$$')).toMatch(
      /<li>\s*⟦x = 1⟧\s*<\/li>\s*<li>\s*⟦y = 2⟧/,
    );
  });

  it('leaves unclosed math as written, as it streams', () => {
    expect(view('Before\n\n$$\nx = ')).toContain('<p>$$\nx =</p>');
    expect(view('Before\n\n\\[\nx = ')).toContain('<p>[\nx =</p>');
    expect(view('\\begin{align}\na &= b\n\nAfter **bold**')).toContain(
      '<p>After <strong>bold</strong></p>',
    );
  });
});

describe('tables', () => {
  it('keeps pipes in math within their cell', () => {
    const table = view(
      '| a | b | c |\n| --- | --- | --- |\n| $|x|$ | $\\|y\\|$ | $P(A|B)$ and \\(a|b\\) |\n| $5 | $10 | x |',
    );
    expect(table).toContain('<td>⟨\\vert x\\vert⟩</td><td>⟨\\vert y\\vert⟩</td>');
    expect(table).toContain('<td>⟨P(A\\vert B)⟩ and ⟨a\\vert b⟩</td>');
    expect(table).toContain('<td>$5</td><td>$10</td>');
    const fenced = '```\n| $|x|$ |\n```';
    expect(view(fenced)).toContain('| $|x|$ |');
  });
});

describe('KaTeX', () => {
  it('sets what models write and KaTeX lacks', () => {
    expect(view('$\\ce{H2O}$ and $\\pu{123 kJ}$')).toContain('⟨\\ce{H2O}⟩ and ⟨\\pu{123 kJ}⟩<');
    expect(view('$\\mathbbm{1}_A + \\abs{x} + \\norm{v}$')).not.toContain('!');
    const labelled = view('$$\n\\begin{equation}\\label{eq:1}\nx = 1\n\\end{equation}\n$$');
    expect(labelled.replace(/⟦[^⟧]*⟧/, '')).not.toContain('eq:1');
    for (const environment of ['multline', 'flalign', 'eqnarray'])
      expect(
        view(`\\begin{${environment}}\na &= b\n\\end{${environment}}`),
        environment,
      ).not.toMatch(/katex-error|!/);
  });

  it('sets environments KaTeX allows only in display mode as display math', () => {
    expect(view('Then $\\begin{align} a&=b \\end{align}$ holds.')).toMatch(/Then ⟦[^⟧]+⟧ holds/);
  });

  it('keeps one formula’s definitions from the next', () => {
    expect(view('$\\gdef\\foo{1}\\foo$ and $\\foo$')).toMatch(/⟨[^⟩]+⟩ and ⟨\\foo⟩!/);
  });
});

it('reads unclosed delimiters in time linear in their number', () => {
  const start = performance.now();
  for (const text of [
    ['\\(a ', '\\[a ', '$a '].map((open) => open.repeat(4000)).join('\n\n'),
    '\\[\n'.repeat(3000),
  ])
    renderToStaticMarkup(<Markdown text={text} />);
  // Quadratic reading took over ten seconds here; linear takes a fraction of a second.
  expect(performance.now() - start).toBeLessThan(2000);
});
