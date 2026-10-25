import type { Element, Root as HastRoot } from 'hast';
import type { Root } from 'mdast';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import { mathFromMarkdown, type Math } from 'mdast-util-math';
import type { Code, Construct, Effects, Extension, State, Token } from 'micromark-util-types';
import { visit } from 'unist-util-visit';
import 'katex/contrib/mhchem';

// Inline math uses the tokens mdast-util-math turns into `inlineMath` nodes; display math has its own.
declare module 'micromark-util-types' {
  interface TokenTypeMap {
    mathText: 'mathText';
    mathTextData: 'mathTextData';
    mathTextSequence: 'mathTextSequence';
    displayMath: 'displayMath';
    displayMathValue: 'displayMathValue';
  }
}

const TAB = -2;
const VIRTUAL_SPACE = -1;
const SPACE = 32;
const DOLLAR = 36;
const LEFT_PAREN = 40;
const RIGHT_PAREN = 41;
const LEFT_BRACKET = 91;
const BACKSLASH = 92;
const RIGHT_BRACKET = 93;
/** Characters prose seldom has and TeX often does: `\`, `^`, `_`, `{`, and `=`. */
const TEX: Code[] = [BACKSLASH, 94, 95, 123, 61];

/** A space, a tab, or a line ending, which micromark codes as negative numbers besides the space. */
const blank = (code: Code) => code !== null && (code < 0 || code === SPACE || code === 9);
const lineEnding = (code: Code) => code !== null && code < TAB;
const digit = (code: Code) => code !== null && code >= 48 && code <= 57;
const letter = (code: Code) => code !== null && /[A-Za-z]/.test(String.fromCharCode(code));
const punctuation = (code: Code) =>
  code !== null && /[!-/:-@[-`{-~]/.test(String.fromCharCode(code));

/** Whether a `$` after `before` may open math between single dollars: `US$5` is a price. */
const opensAfter = (before: Code) => !letter(before) && !digit(before);

/**
 * Whether a `$` between `before` and `after` closes math between single dollars that opened with a
 * space or not, and that has TeX in it or not.
 */
function closesBetween(before: Code, after: Code, padded: boolean, tex: boolean) {
  if (after === DOLLAR || digit(after)) return false;
  if (padded) return blank(before) && tex;
  // `$HOME/$USER` names two variables.
  return (
    !blank(before) &&
    !(letter(after) && punctuation(before) && !")]}'".includes(String.fromCharCode(before!)))
  );
}

/**
 * Environments that are math by themselves, so a line can open display math with them without
 * `$$` or `\[`.
 */
const ENVIRONMENT =
  /^\\begin\{((?:equation|align|alignat|gather|multline|flalign|eqnarray)\*?|CD|aligned|alignedat|gathered|split|[dr]?cases|[pbBvV]?matrix|array)\}/;
/** Environments KaTeX sets only in display mode, so inline math made of one is shown as display. */
const DISPLAY_ONLY =
  /^\s*\\begin\{(?:(?:equation|align|alignat|gather|multline|flalign|eqnarray)\*?|CD)\}/;

/** Where `delimiter` first appears in `text` from `from`, skipping characters escaped with `\`. */
function indexOfDelimiter(text: string, delimiter: string, from = 0) {
  for (let index = from; index < text.length; index++) {
    if (text.startsWith(delimiter, index)) return index;
    if (text[index] === '\\') index++;
  }
  return -1;
}

/**
 * Math between single dollars, read so prices stay prose. As in TeX, the next `$` closes it; as in
 * Pandoc, the opening `$` comes before a non-space, and the closing one after a non-space and not
 * before a digit. `$ x $` is math only when TeX shows in it. Math between `$$` may hold anything.
 */
const dollarMath: Construct = {
  name: 'dollarMath',
  previous(code) {
    // A `$` right after another belongs to its run.
    if (code === DOLLAR) return this.events.at(-1)?.[1].type === 'characterEscape';
    return opensAfter(code);
  },
  tokenize(effects, ok, nok) {
    let size = 0;
    let closing = 0;
    let last: Code = null;
    let padded = false;
    let tex = false;
    let empty = true;
    let sequence: Token;
    return start;

    function start(code: Code): State | undefined {
      effects.enter('mathText');
      effects.enter('mathTextSequence');
      return open(code);
    }
    function open(code: Code): State | undefined {
      if (code === DOLLAR) {
        effects.consume(code);
        size++;
        return open;
      }
      if (size > 2 || code === null || (size === 1 && lineEnding(code))) return nok(code);
      effects.exit('mathTextSequence');
      padded = blank(code);
      return between(code);
    }
    function between(code: Code): State | undefined {
      if (code === null) return nok(code);
      if (code === DOLLAR) {
        sequence = effects.enter('mathTextSequence');
        closing = 0;
        return close(code);
      }
      if (lineEnding(code)) {
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        last = code;
        return between;
      }
      effects.enter('mathTextData');
      return data(code);
    }
    function data(code: Code): State | undefined {
      if (code === null || code === DOLLAR || lineEnding(code)) {
        effects.exit('mathTextData');
        return between(code);
      }
      take(code);
      return code === BACKSLASH ? escaped : data;
    }
    // `\$` is a dollar within the math, not its end.
    function escaped(code: Code): State | undefined {
      if (code === null || lineEnding(code)) return data(code);
      take(code);
      return data;
    }
    function take(code: Code) {
      effects.consume(code);
      last = code;
      if (!blank(code)) empty = false;
      if (TEX.includes(code)) tex = true;
    }
    function close(code: Code): State | undefined {
      if (code === DOLLAR) {
        effects.consume(code);
        closing++;
        return close;
      }
      if (closing === size) {
        if (empty || (size === 1 && !closesBetween(last, code, padded, tex))) return nok(code);
        effects.exit('mathTextSequence');
        effects.exit('mathText');
        return ok(code);
      }
      // A `$` that cannot close math between single dollars means there is none.
      if (size === 1) return nok(code);
      sequence.type = 'mathTextData';
      effects.exit('mathTextData');
      last = DOLLAR;
      return between(code);
    }
  },
};

/**
 * Math between `\(` and `\)`, or between `\[` and `\]` within a paragraph. `\[1\]` is an escaped
 * bracket, as Markdown has it, unless spaces pad it or TeX shows in it.
 */
const backslashMath: Construct = {
  name: 'backslashMath',
  tokenize(effects, ok, nok) {
    let closer: number;
    let last: Code = null;
    let padded = false;
    let tex = false;
    let empty = true;
    const closing: Construct = { partial: true, tokenize: tokenizeClosing };
    return start;

    function start(code: Code): State | undefined {
      effects.enter('mathText');
      effects.enter('mathTextSequence');
      effects.consume(code);
      return open;
    }
    function open(code: Code): State | undefined {
      if (code !== LEFT_PAREN && code !== LEFT_BRACKET) return nok(code);
      closer = code === LEFT_PAREN ? RIGHT_PAREN : RIGHT_BRACKET;
      effects.consume(code);
      effects.exit('mathTextSequence');
      return first;
    }
    function first(code: Code): State | undefined {
      padded = blank(code);
      return between(code);
    }
    function between(code: Code): State | undefined {
      if (code === null) return nok(code);
      if (code === BACKSLASH) return effects.attempt(closing, done, escape)(code);
      if (lineEnding(code)) {
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        last = code;
        return between;
      }
      effects.enter('mathTextData');
      return data(code);
    }
    function data(code: Code): State | undefined {
      if (code === null || code === BACKSLASH || lineEnding(code)) {
        effects.exit('mathTextData');
        return between(code);
      }
      take(code);
      return data;
    }
    // A backslash that does not close the math escapes the character after it. Math cannot hold
    // `\(` or `\[`, so one means the math has no end.
    function escape(code: Code): State | undefined {
      effects.enter('mathTextData');
      take(code);
      return escaped;
    }
    function escaped(code: Code): State | undefined {
      if (code === LEFT_PAREN || code === LEFT_BRACKET) return nok(code);
      if (code === null || lineEnding(code)) return data(code);
      take(code);
      return data;
    }
    function take(code: Code) {
      effects.consume(code);
      last = code;
      if (!blank(code)) empty = false;
      if (TEX.includes(code)) tex = true;
    }
    function done(code: Code): State | undefined {
      if (empty || (closer === RIGHT_BRACKET && !padded && !blank(last) && !tex)) return nok(code);
      effects.exit('mathText');
      return ok(code);
    }
    function tokenizeClosing(effects: Effects, closed: State, open: State): State {
      return (code) => {
        effects.enter('mathTextSequence');
        effects.consume(code);
        return (next) => {
          if (next !== closer) return open(next);
          effects.consume(next);
          effects.exit('mathTextSequence');
          return closed;
        };
      };
    }
  },
};

/** A line ending within display math, unless the line after it is a lazy one. */
const nonLazyLineEnding: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    return (code) => {
      effects.enter('lineEnding');
      effects.consume(code);
      effects.exit('lineEnding');
      return (next) => (this.parser.lazy[this.now().line] ? nok(next) : ok(next));
    };
  },
};

/** How display math that `line` opens ends, if `line` opens any. */
function displayDelimiters(line: string) {
  if (/^\$\$(?!\$)/.test(line)) return { open: '$$', close: '$$' };
  if (line.startsWith('\\[')) return { open: '\\[', close: '\\]' };
  const environment = ENVIRONMENT.exec(line)?.[1];
  return environment === undefined ? undefined : { open: '', close: `\\end{${environment}}` };
}

/**
 * Display math as a block: lines from one that starts with `$$`, `\[`, or `\begin` of a math
 * environment, to one that ends with the matching `$$`, `\]`, or `\end`. The math may start on the
 * first line and end on the last, and its lines may be blank or look like Markdown. Unclosed, the
 * lines are read as a paragraph instead.
 */
const displayMath: Construct = {
  name: 'displayMath',
  concrete: true,
  tokenize(effects, ok, nok) {
    const interrupt = this.interrupt;
    const tail = this.events.at(-1);
    const indent =
      tail?.[1].type === 'linePrefix' ? tail[2].sliceSerialize(tail[1], true).length : 0;
    let delimiters: ReturnType<typeof displayDelimiters>;
    let line = '';
    let text = '';
    let depth = 0;
    let prefix = 0;
    return start;

    function start(code: Code): State | undefined {
      effects.enter('displayMath');
      return content(code);
    }
    function content(code: Code): State | undefined {
      if (code === null || lineEnding(code)) return end(code);
      effects.enter('displayMathValue');
      return value(code);
    }
    function value(code: Code): State | undefined {
      if (code === null || lineEnding(code)) {
        effects.exit('displayMathValue');
        return end(code);
      }
      line += code === TAB ? '\t' : code === VIRTUAL_SPACE ? ' ' : String.fromCodePoint(code);
      effects.consume(code);
      return value;
    }
    function end(code: Code): State | undefined {
      const first = !delimiters;
      delimiters ??= displayDelimiters(line);
      if (!delimiters) return nok(code);
      const closed = closes(line, first);
      const written = line;
      text += `${line}\n`;
      line = '';
      if (closed === undefined) return nok(code);
      if (closed) {
        if (!displaySource(text).trim()) return nok(code);
        effects.exit('displayMath');
        return ok(code);
      }
      // A paragraph ends at `$$` or `\[` alone on its line or before TeX, not at `$$ is the PID`, and
      // not at `\begin`, which is often within math the paragraph holds.
      if (first && interrupt) {
        const rest = written.slice(delimiters.open.length).trim();
        return delimiters.open && (!rest || /[\\^_{=]/.test(rest)) ? ok(code) : nok(code);
      }
      if (code === null) return nok(code);
      return effects.attempt(nonLazyLineEnding, linePrefix, nok)(code);
    }
    // Whether `line` closes the math, or undefined if it closes it with text after.
    function closes(line: string, first: boolean) {
      const { open, close } = delimiters!;
      if (!open) {
        depth += line.split(close.replace('\\end', '\\begin')).length - 1;
        depth -= line.split(close).length - 1;
        if (depth > 0) return false;
        return line.trimEnd().endsWith(close) || undefined;
      }
      const from = first ? open.length : 0;
      const at = indexOfDelimiter(line, close, from);
      // Math cannot hold `\[`, so one means the math has no end.
      if (
        open === '\\[' &&
        indexOfDelimiter(line.slice(0, at === -1 ? undefined : at), open, from) !== -1
      )
        return undefined;
      if (at === -1) return false;
      if (line.slice(at + close.length).trim()) return undefined;
      // On one line, `\[1\]` is an escaped bracket unless spaces pad it or TeX shows in it.
      const math = line.slice(from, at);
      return !(first && open === '\\[' && !/^\s|\s$|[\\^_{=]/.test(math)) || undefined;
    }
    function linePrefix(code: Code): State | undefined {
      if (prefix < indent && (code === SPACE || code === TAB || code === VIRTUAL_SPACE)) {
        if (!prefix) effects.enter('linePrefix');
        prefix++;
        effects.consume(code);
        return linePrefix;
      }
      if (prefix) effects.exit('linePrefix');
      prefix = 0;
      return content(code);
    }
  },
};

/** The TeX of display math as written, without the `$$` or `\[` and `\]` around it. */
function displaySource(written: string) {
  const text = written.trim();
  return text.startsWith('$$') || text.startsWith('\\[') ? text.slice(2, -2).trim() : text;
}

/** A display math node for `value`, which rehype-katex sets in display mode. */
function displayNode(value: string, position?: Math['position']): Math {
  return {
    type: 'math',
    value,
    position,
    data: {
      hName: 'pre',
      hChildren: [
        {
          type: 'element',
          tagName: 'code',
          properties: { className: ['language-math', 'math-display'] },
          children: [{ type: 'text', value }],
        },
      ],
    },
  };
}

const displayFromMarkdown: FromMarkdownExtension = {
  enter: {
    displayMath(token) {
      this.enter({ type: 'math', value: '' }, token);
      this.buffer();
    },
  },
  exit: {
    displayMathValue(token) {
      this.config.enter.data!.call(this, token);
      this.config.exit.data!.call(this, token);
    },
    displayMath(token) {
      const written = this.resume();
      const node = this.stack.at(-1) as Math;
      this.exit(token);
      Object.assign(node, displayNode(displaySource(written), node.position));
    },
  },
};

/**
 * Math as models write it: `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`, in prose or as blocks, and math
 * environments on their own.
 */
export function remarkMath(this: { data(): object }) {
  // remark-parse reads its syntax extensions from these lists.
  const data = this.data() as {
    micromarkExtensions?: Extension[];
    fromMarkdownExtensions?: FromMarkdownExtension[];
  };
  (data.micromarkExtensions ??= []).push({
    flow: { [DOLLAR]: displayMath, [BACKSLASH]: displayMath },
    text: { [DOLLAR]: dollarMath, [BACKSLASH]: backslashMath },
  });
  (data.fromMarkdownExtensions ??= []).push(mathFromMarkdown(), displayFromMarkdown);
}

/**
 * Shows as display math what a paragraph holds alone or across lines between `$$`, anything between
 * `\[` and `\]`, and environments KaTeX sets only in display mode. Math between `$$` within a line of
 * prose stays inline, as some models write inline math.
 */
export function remarkDisplayMath() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    const opener = (offset: number | undefined) =>
      offset === undefined ? '' : source.slice(offset, offset + 2);
    visit(tree, 'paragraph', (node, index, parent) => {
      const math = node.children.length === 1 ? node.children[0] : undefined;
      if (math?.type !== 'inlineMath' || index === undefined || !parent) return;
      const delimiter = opener(math.position?.start.offset);
      if (delimiter !== '$$' && delimiter !== '\\[' && !DISPLAY_ONLY.test(math.value)) return;
      parent.children[index] = displayNode(math.value.trim(), math.position);
    });
    visit(tree, 'inlineMath', (node) => {
      const delimiter = opener(node.position?.start.offset);
      const lines = delimiter === '$$' && /[\r\n]/.test(node.value);
      if (delimiter !== '\\[' && !lines && !DISPLAY_ONLY.test(node.value)) return;
      node.data = { ...node.data, hProperties: { className: ['language-math', 'math-display'] } };
    });
  };
}

/** Pipes in `math`, as `\vert`: GFM splits table cells at `|`, and reads `\|` there as one too. */
const vert = (math: string) =>
  math.replace(/\\[\s\S]|\|/g, (match, offset: number) => {
    if (match !== '|' && match !== '\\|') return match;
    return /[A-Za-z]/.test(math[offset + match.length] ?? '') ? '\\vert ' : '\\vert';
  });

/** The code of the character at `index` of `text`, as micromark has it. */
const codeAt = (text: string, index: number): Code => text.codePointAt(index) ?? null;

/** Where math that starts at `index` of `text` ends, by the rules the parser reads it with. */
function mathEnd(text: string, index: number): number | undefined {
  const rest = text.slice(index);
  const backslash = /^\\([([])/.exec(rest);
  if (backslash) {
    const close = backslash[1] === '(' ? '\\)' : '\\]';
    const at = indexOfDelimiter(text, close, index + 2);
    return at > index + 2 ? at + 2 : undefined;
  }
  const size = /^\$+/.exec(rest)?.[0].length;
  const before = index ? codeAt(text, index - 1) : null;
  if ((size !== 1 && size !== 2) || before === DOLLAR || !opensAfter(before)) return;
  const at = indexOfDelimiter(text, size === 2 ? '$$' : '$', index + size);
  if (at === -1) return;
  const math = text.slice(index + size, at);
  if (!math.trim()) return;
  if (size === 2) return at + 2;
  const padded = blank(codeAt(text, index + 1));
  const closes = closesBetween(
    codeAt(text, at - 1),
    codeAt(text, at + 1),
    padded,
    /[\\^_{=]/.test(math),
  );
  return closes ? at + 1 : undefined;
}

/**
 * Text with the pipes in the math of table rows written as `\vert`, so `$P(A|B)$` stays in its
 * cell. Code stays as written.
 */
export function protectTableMath(source: string): string {
  let fence: string | undefined;
  return source.replace(/^.*$/gm, (line) => {
    const prefix = /^(?:[ \t]*>)*[ \t]*/.exec(line)![0];
    const rest = line.slice(prefix.length);
    const marker = /^(?:`{3,}|~{3,})/.exec(rest)?.[0];
    if (fence) {
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        !rest.slice(marker.length).trim()
      )
        fence = undefined;
      return line;
    }
    if (marker) {
      fence = marker;
      return line;
    }
    if (!rest.startsWith('|') || !/[$\\]/.test(rest)) return line;
    let row = '';
    for (let index = 0; index < rest.length;) {
      const end = mathEnd(rest, index);
      if (end !== undefined) {
        row += vert(rest.slice(index, end));
        index = end;
      } else if (rest[index] === '`') {
        const run = /^`+/.exec(rest.slice(index))![0];
        const close = rest.indexOf(run, index + run.length);
        const until = close === -1 ? index + run.length : close + run.length;
        row += rest.slice(index, until);
        index = until;
      } else {
        const until = rest[index] === '\\' ? index + 2 : index + 1;
        row += rest.slice(index, until);
        index = until;
      }
    }
    return prefix + row;
  });
}

/** Environments KaTeX lacks, as the nearest it has. */
const ENVIRONMENT_ALIASES: Record<string, string> = {
  multline: 'gather',
  flalign: 'align',
};

/** Writes math environments KaTeX lacks as ones it has, before KaTeX reads them. */
export function rehypeMathSource() {
  return (tree: HastRoot) => {
    visit(tree, 'element', (node: Element) => {
      const classes = node.properties.className;
      if (node.tagName !== 'code' || !Array.isArray(classes) || !classes.includes('language-math'))
        return;
      const text = node.children[0];
      if (text?.type !== 'text') return;
      text.value = text.value
        .replace(
          /\\(begin|end)\{(multline|flalign)(\*?)\}/g,
          (_match, side: string, environment: string, star: string) =>
            `\\${side}{${ENVIRONMENT_ALIASES[environment]}${star}}`,
        )
        .replace(/\\begin\{eqnarray\*?\}/g, '\\begin{array}{rcl}')
        .replace(/\\end\{eqnarray\*?\}/g, '\\end{array}');
    });
  };
}

/** Commands models write that KaTeX lacks. */
const MACROS = {
  // KaTeX numbers equations itself, and nothing refers to a label.
  '\\label': { tokens: [], numArgs: 1 },
  '\\mathbbm': '\\mathbb',
  '\\mathds': '\\mathbb',
  '\\abs': '\\left\\lvert #1 \\right\\rvert',
  '\\norm': '\\left\\lVert #1 \\right\\rVert',
};

/** How rehype-katex sets math. */
export const katexOptions = {
  trust: false,
  strict: 'ignore',
  maxExpand: 1000,
  maxSize: 20,
  errorColor: 'var(--danger)',
  // KaTeX keeps a formula's `\gdef` in the macros it was given, and rehype-katex spreads these
  // options for each formula, so each gets its own.
  get macros() {
    return { ...MACROS };
  },
} as const;

export function rehypeMathAccessibility() {
  return (tree: HastRoot) => {
    visit(tree, 'element', (node) => {
      if (
        Array.isArray(node.properties.className) &&
        node.properties.className.includes('katex-display')
      )
        Object.assign(node.properties, { tabIndex: 0, role: 'group', ariaLabel: 'Math formula' });
    });
  };
}
