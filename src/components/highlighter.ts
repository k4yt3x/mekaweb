import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages } from 'shiki/langs';
import light from '@shikijs/themes/github-light-default';
import dark from '@shikijs/themes/github-dark';
// Shiki's map includes its own aliases; these fill common tags it lacks.
const aliases: Record<string, string> = {
  patch: 'diff',
  golang: 'go',
};
const highlighter = createHighlighterCore({
  themes: [light, dark],
  langs: [],
  engine: createJavaScriptRegexEngine(),
});
function languageName(language: string) {
  const normalized = language.toLowerCase();
  const name = (Object.hasOwn(aliases, normalized) ? aliases[normalized] : undefined) ?? normalized;
  return Object.hasOwn(bundledLanguages, name)
    ? (name as keyof typeof bundledLanguages)
    : undefined;
}
// Resolves to a highlighter that works synchronously, so a block can highlight as it renders.
export async function load(language: string) {
  const name = languageName(language);
  if (!name) return undefined;
  const engine = await highlighter;
  // Each grammar is its own chunk, fetched the first time a block uses it.
  await engine.loadLanguage((await bundledLanguages[name]()).default);
  return (text: string) => {
    if (text.length > 100000) return undefined;
    try {
      return engine.codeToTokens(text, {
        lang: name,
        themes: { light: 'github-light-default', dark: 'github-dark' },
      }).tokens;
    } catch {
      // This runs during render, where a throw would take down the conversation.
      return undefined;
    }
  };
}
