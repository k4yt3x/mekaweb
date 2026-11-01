import { createContext, useContext, useEffect, useRef } from 'react';

/**
 * What a session's workspace offers what is shown in it: Files, opened at a path, the editor, its
 * terminals, the session's context, and the message being written, which a path can be added to.
 */
export interface Workspace {
  /** Opens Files at the folder `path`, showing the file `open` in it, and opening it, if given. */
  openFiles(path: string, open?: string): void;
  /** Opens the file `path` in the editor. */
  openFile(path: string): void;
  /** The session's working directory, or the folder chosen for a new one. */
  folder: string;
  /** Shows the file `path` in Files, chosen in its folder, without opening it. */
  showFile(path: string): void;
  /**
   * Starts a terminal in the folder `cwd`, the session's working directory unless given, in a tab
   * of the editor; none where the session cannot have terminals.
   */
  openTerminal: ((cwd?: string) => void) | undefined;
  /** Shows the session's context. */
  showContext(): void;
  /** Adds `text` to the message being written; whether a composer took it. */
  mention(text: string): boolean;
  /** Takes mentions into `insert`, until the returned function is called. */
  takeMentions(insert: (text: string) => void): () => void;
}

const WorkspaceContext = createContext<Workspace | undefined>(undefined);

export const WorkspaceProvider = WorkspaceContext.Provider;

/** The workspace this is shown in, if any. */
export function useWorkspace(): Workspace | undefined {
  return useContext(WorkspaceContext);
}

/** Has the composer shown with it take mentions, through `setText`. */
export function useMentions(setText: (update: (value: string) => string) => void) {
  const workspace = useWorkspace();
  const latest = useRef(setText);
  useEffect(() => {
    latest.current = setText;
  });
  useEffect(
    () =>
      workspace?.takeMentions((text) =>
        latest.current((value) => {
          if (!value) return text;
          return /\s$/.test(value) ? value + text : `${value} ${text}`;
        }),
      ),
    [workspace],
  );
}

/** Hands the keyboard to the message being written in the session shown. */
export function focusMessage() {
  document
    .querySelector<HTMLTextAreaElement>('.session-main textarea[aria-label="Message"]')
    ?.focus();
}

/** A path as it is added to a message: quoted when it holds white space. */
export function mentionPath(path: string): string {
  return /\s/.test(path) ? `\`${path}\`` : path;
}
