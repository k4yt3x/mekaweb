import { createContext, useContext, type RefObject } from 'react';
import type { ConversationAppearance } from '../connections/storage';

export type ReadingOptions = ConversationAppearance;
export type ReadingState = {
  options: ReadingOptions;
  /** What the conversation is centered on: the page, unless it cannot be there, then its area. */
  anchor: ReadingOptions['anchor'];
  adjusted: boolean;
  change: (options: Partial<ReadingOptions> | null) => void;
  saveDefaults: (options: ReadingOptions) => void;
  pane: RefObject<HTMLElement | null>;
  /** Keeps the center guide on screen while the offset slider is held. */
  holdGuide: (holding: boolean) => void;
};
export const ReadingContext = createContext<ReadingState | null>(null);

/** The pane's conversation font size, for layout that measures text; undefined outside a pane. */
export function useReadingFontSize() {
  return useContext(ReadingContext)?.options.fontSize;
}
