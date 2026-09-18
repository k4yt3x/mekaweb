import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import { createId } from '../identifiers';

let queue: Promise<unknown> = Promise.resolve();
export function renderDiagram(source: string, dark: boolean, signal: AbortSignal) {
  const render = async () => {
    signal.throwIfAborted();
    if (source.length > 20000) throw new Error('This diagram is too large to preview.');
    // Content cannot override security, styling, or resource limits through frontmatter/directives.
    if (/^\s*---|%%\s*\{/m.test(source))
      throw new Error('Diagram configuration directives are not supported.');
    if (
      /(?:\b(?:https?|ftp|file|data|javascript):|\/\/|\b(?:img|image)\s*:|\burl\s*\(|@import|@font-face)/i.test(
        source,
      )
    )
      throw new Error('External resources and image nodes are not supported in diagram previews.');
    const config = {
      startOnLoad: false,
      securityLevel: 'strict' as const,
      suppressErrorRendering: true,
      theme: 'base' as const,
      themeVariables: {
        darkMode: dark,
        background: dark ? '#161616' : '#ffffff',
        primaryColor: dark ? '#262626' : '#edf3ff',
        primaryTextColor: dark ? '#ebebeb' : '#202632',
        primaryBorderColor: dark ? '#b4b4b4' : '#4774b9',
        lineColor: dark ? '#9b9b9b' : '#65758b',
        secondaryColor: dark ? '#1f1f1f' : '#f7f8fa',
        tertiaryColor: dark ? '#161616' : '#ffffff',
        actorBkg: dark ? '#262626' : '#edf3ff',
        actorBorder: dark ? '#b4b4b4' : '#4774b9',
        actorTextColor: dark ? '#ebebeb' : '#202632',
        signalColor: dark ? '#9b9b9b' : '#65758b',
        signalTextColor: dark ? '#ebebeb' : '#202632',
        edgeLabelBackground: dark ? '#161616' : '#ffffff',
        noteBkgColor: dark ? '#1f1f1f' : '#f7f8fa',
        noteTextColor: dark ? '#ebebeb' : '#202632',
      },
      fontFamily: 'system-ui, sans-serif',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      maxTextSize: 20000,
      maxEdges: 300,
      logLevel: 'fatal' as const,
    };
    mermaid.initialize({ ...config, secure: Object.keys(config) });
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none';
    document.body.append(host);
    try {
      const result = await mermaid.render(`diagram-${createId()}`, source, host);
      signal.throwIfAborted();
      const clean = DOMPurify.sanitize(result.svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['foreignObject', 'script', 'image', 'a'],
      });
      const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml');
      const svg = parsed.documentElement;
      if (svg.localName !== 'svg' || parsed.querySelector('parsererror'))
        throw new Error('The diagram could not be rendered.');
      const externalResource = (value: string) =>
        /@import|@font-face|expression\(/i.test(value) ||
        [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].some(
          (match) => !match[2]?.trim().startsWith('#'),
        );
      for (const style of svg.querySelectorAll('style'))
        if (externalResource(style.textContent ?? ''))
          throw new Error('External diagram resources are not supported.');
      // No external references can leave the browser through the generated image.
      for (const element of svg.querySelectorAll('*')) {
        for (const attribute of Array.from(element.attributes)) {
          if (
            (attribute.localName === 'href' && !attribute.value.startsWith('#')) ||
            externalResource(attribute.value)
          )
            element.removeAttributeNode(attribute);
        }
      }
      const [, , width, height] = (svg.getAttribute('viewBox') ?? '').split(/[ ,]+/).map(Number);
      if (
        !width ||
        !height ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width > 8192 ||
        height > 8192
      )
        throw new Error('This diagram is too large to preview.');
      svg.setAttribute('width', String(Math.ceil(width)));
      svg.setAttribute('height', String(Math.ceil(height)));
      const title = svg.querySelector('title')?.textContent || 'Mermaid diagram';
      return {
        blob: new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }),
        title,
      };
    } finally {
      host.remove();
    }
  };
  const result = queue.then(render, render);
  queue = result.catch(() => undefined);
  return result;
}
