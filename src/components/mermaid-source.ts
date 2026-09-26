import { JSON_SCHEMA, load } from 'js-yaml';

function svgFlowchartLabels(body: string) {
  if (!/^\s*(?:%%[^\n]*\n\s*)*(?:graph|flowchart)\b/.test(body)) return body;
  return body.replace(
    /([([{]\s*)"([^"\n]*)"(\s*[)\]}])/g,
    (whole, open: string, label: string, close: string) => {
      if (!/<(?:b|strong|i|em)>/i.test(label)) return whole;
      const plain = label.replace(/<\/?(?:b|strong|i|em)>|<br\s*\/?>/gi, '');
      // Only translate simple formatting. Existing Markdown, escapes, or other HTML stay literal.
      if (/[<>`*_\\]/.test(plain) || plain.includes('[') || plain.includes(']')) return whole;
      const stack: string[] = [];
      let balanced = true;
      const markdown = label.replace(
        /<(\/?)(b|strong|i|em)>|<br\s*\/?>/gi,
        (_tag, slash: string, name: string) => {
          if (!name) return '<br/>';
          const kind = name.toLowerCase();
          if (slash) balanced &&= stack.pop() === kind;
          else stack.push(kind);
          return kind === 'b' || kind === 'strong' ? '**' : '*';
        },
      );
      // Mermaid's SVG text mode understands Markdown emphasis but prints HTML tags verbatim.
      return balanced && !stack.length ? `${open}"\`${markdown}\`"${close}` : whole;
    },
  );
}

export function prepareDiagram(source: string) {
  if (source.length > 20000) throw new Error('This diagram is too large to preview.');
  let body = source
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[ \t]*\n)*/, '')
    .trimEnd();
  let title: string | undefined;
  if (/^[ \t]*---[ \t]*(?:\n|$)/.test(body)) {
    const frontmatter = /^([ \t]*)---[ \t]*\n([\s\S]*?)\n\1---[ \t]*(?:\n|$)/.exec(body);
    if (!frontmatter) throw new Error('The diagram frontmatter is incomplete.');
    const metadata: unknown = load(frontmatter[2]!, { schema: JSON_SCHEMA }) ?? {};
    if (
      typeof metadata !== 'object' ||
      metadata === null ||
      Array.isArray(metadata) ||
      Object.keys(metadata).some((key) => key !== 'title') ||
      ('title' in metadata && typeof metadata.title !== 'string')
    )
      throw new Error('Only a text title is supported in diagram frontmatter.');
    if ('title' in metadata) title = metadata.title as string;
    body = body.slice(frontmatter[0].length);
  }
  // Metadata must not change the renderer's security, styling, or resource limits.
  if (/^\s*---|%%\s*\{/m.test(body))
    throw new Error('Diagram configuration directives are not supported.');
  if (
    /(?:\b(?:https?|ftp|file|data|javascript):|\/\/|\b(?:img|image)\s*:|\burl\s*\(|@import|@font-face)/i.test(
      source,
    )
  )
    throw new Error('External resources and image nodes are not supported in diagram previews.');
  body = svgFlowchartLabels(body);
  // Serialize the validated title so YAML aliases or multiline values cannot become config.
  return {
    source: title === undefined ? body : `---\ntitle: ${JSON.stringify(title)}\n---\n${body}`,
    title,
  };
}
