import type { ComposerOptions } from './controller';

export const DEFAULT_INPUT_HEIGHT = 68;

export const emptyComposerOptions: ComposerOptions = {
  images: [],
  skill: '',
  retention: 'keep',
  mode: 'steer',
  source: '',
};

export function remainingComposerOptions(
  current: ComposerOptions,
  sent: ComposerOptions,
): ComposerOptions {
  return {
    ...current,
    images: current.images.filter((image) => !sent.images.includes(image)),
    skill: current.skill === sent.skill ? '' : current.skill,
  };
}
