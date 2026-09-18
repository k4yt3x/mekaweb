import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';

export function remarkAdmonitions() {
  return (tree: Root) => {
    visit(tree, 'blockquote', (node) => {
      const paragraph = node.children[0];
      const first = paragraph?.type === 'paragraph' ? paragraph.children[0] : undefined;
      if (first?.type !== 'text') return;
      const marker = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i.exec(first.value);
      if (!marker) return;
      const kind = marker[1]!.toLowerCase();
      first.value = first.value.slice(marker[0].length);
      node.data = {
        ...node.data,
        hProperties: {
          className: ['markdown-alert', `markdown-alert-${kind}`],
          'data-alert': kind,
        },
      };
    });
  };
}

export function remarkDisplayMath() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    visit(tree, 'paragraph', (node, index, parent) => {
      const math = node.children.length === 1 ? node.children[0] : undefined;
      if (math?.type !== 'inlineMath' || index === undefined || !parent) return;
      const start = math.position?.start.offset;
      if (start === undefined || source.slice(start, start + 2) !== '$$') return;
      parent.children[index] = {
        type: 'math',
        value: math.value,
        data: {
          hName: 'div',
          hChildren: [
            {
              type: 'element',
              tagName: 'code',
              properties: { className: ['language-math', 'math-display'] },
              children: [{ type: 'text', value: math.value }],
            },
          ],
        },
      };
    });
  };
}

// Normalize common TeX delimiters only in prose, leaving fenced, indented, and inline code intact.
export function normalizeMathDelimiters(source: string): string {
  function prose(value: string): string {
    const normalized = (text: string) =>
      text
        .replace(
          /(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g,
          (_match, math: string) => `\n$$\n${math}\n$$\n`,
        )
        .replace(/(?<!\\)\\\(([^\n]*?)(?<!\\)\\\)/g, (_match, math: string) => `$${math}$`);
    const code = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
    let result = '',
      position = 0;
    for (const match of value.matchAll(code)) {
      result += normalized(value.slice(position, match.index)) + match[0];
      position = match.index + match[0].length;
    }
    return result + normalized(value.slice(position));
  }
  let result = '',
    pending = '',
    fence: { marker: string; length: number } | undefined;
  for (const line of source.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      result += line;
      if (
        marker?.[0] === fence.marker &&
        marker.length >= fence.length &&
        line.slice(line.indexOf(marker) + marker.length).trim() === ''
      )
        fence = undefined;
    } else if (marker || /^(?: {4}|\t)/.test(line)) {
      result += prose(pending) + line;
      pending = '';
      if (marker) fence = { marker: marker[0]!, length: marker.length };
    } else pending += line;
  }
  return result + prose(pending);
}

export function rehypeTaskLabels() {
  return (tree: import('hast').Root) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'li') return;
      const paragraph = node.children.find(
        (child) => child.type === 'element' && child.tagName === 'p',
      );
      const children = paragraph?.type === 'element' ? paragraph.children : node.children;
      const checkbox = children.find(
        (child) =>
          child.type === 'element' &&
          child.tagName === 'input' &&
          child.properties.type === 'checkbox',
      );
      if (checkbox?.type !== 'element') return;
      function text(nodes: import('hast').ElementContent[]): string {
        return nodes
          .map((child) =>
            child.type === 'text'
              ? child.value
              : child.type === 'element' && !['ul', 'ol', 'input'].includes(child.tagName)
                ? text(child.children)
                : '',
          )
          .join('');
      }
      checkbox.properties.ariaLabel = text(children).replace(/\s+/g, ' ').trim() || 'Task';
    });
  };
}

export function rehypeMathAccessibility() {
  return (tree: import('hast').Root) => {
    visit(tree, 'element', (node) => {
      if (
        Array.isArray(node.properties.className) &&
        node.properties.className.includes('katex-display')
      )
        Object.assign(node.properties, { tabIndex: 0, role: 'group', ariaLabel: 'Math formula' });
    });
  };
}
