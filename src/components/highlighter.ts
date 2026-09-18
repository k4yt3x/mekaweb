import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import light from '@shikijs/themes/github-light-default';
import dark from '@shikijs/themes/github-dark';
const languages = {
  javascript: () => import('@shikijs/langs/javascript'),
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  json: () => import('@shikijs/langs/json'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  sql: () => import('@shikijs/langs/sql'),
  markdown: () => import('@shikijs/langs/markdown'),
  jsx: () => import('@shikijs/langs/jsx'),
  go: () => import('@shikijs/langs/go'),
  java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  diff: () => import('@shikijs/langs/diff'),
  docker: () => import('@shikijs/langs/docker'),
  ruby: () => import('@shikijs/langs/ruby'),
  latex: () => import('@shikijs/langs/latex'),
};
const aliases: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'shellscript',
  bash: 'shellscript',
  shell: 'shellscript',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  patch: 'diff',
  dockerfile: 'docker',
  rb: 'ruby',
  tex: 'latex',
  zsh: 'shellscript',
};
const highlighter = createHighlighterCore({
  themes: [light, dark],
  langs: [],
  engine: createJavaScriptRegexEngine(),
});
export async function highlight(text: string, language: string) {
  const normalized = language.toLowerCase();
  const name = (Object.hasOwn(aliases, normalized) ? aliases[normalized] : undefined) ?? normalized;
  if (!Object.hasOwn(languages, name) || text.length > 100000) return undefined;
  const engine = await highlighter;
  await engine.loadLanguage((await languages[name as keyof typeof languages]()).default);
  return engine.codeToTokens(text, {
    lang: name,
    themes: { light: 'github-light-default', dark: 'github-dark' },
  }).tokens;
}
