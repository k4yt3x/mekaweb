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
