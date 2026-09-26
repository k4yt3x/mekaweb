export const shortcuts = {
  newSession: { label: 'New session', key: 'o', mod: true, shift: true },
  deleteSession: { label: 'Delete session', key: 'Backspace', mod: true, shift: true },
  renameSession: { label: 'Rename session', key: 'r', mod: true, alt: true },
  previousSession: { label: 'Previous session', key: 'ArrowUp', alt: true },
  nextSession: { label: 'Next session', key: 'ArrowDown', alt: true },
  stopTurn: { label: 'Stop turn', key: 'x', mod: true, shift: true },
  searchSessions: { label: 'Search sessions', key: 'k', mod: true },
  showShortcuts: { label: 'Keyboard shortcuts', key: '/', mod: true },
} satisfies Record<
  string,
  { label: string; key: string; mod?: boolean; shift?: boolean; alt?: boolean }
>;

export type Shortcut = keyof typeof shortcuts;
type Binding = { key: string; mod?: boolean; shift?: boolean; alt?: boolean };
type KeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

export function appleKeyboard() {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

export function shortcutHint(action: Shortcut) {
  return shortcutKeys(action, appleKeyboard()).join('+');
}

export function shortcutAttribute(action: Shortcut) {
  return shortcutAria(action, appleKeyboard());
}

export function matchesShortcut(action: Shortcut, event: KeyEvent, apple: boolean) {
  const binding: Binding = shortcuts[action];
  // Option can produce a different character on macOS (Option+R produces ®).
  const keyMatches =
    event.key.toLowerCase() === binding.key.toLowerCase() ||
    (apple && binding.alt && event.code === `Key${binding.key.toUpperCase()}`);
  return Boolean(
    keyMatches &&
    event.ctrlKey === Boolean(binding.mod && !apple) &&
    event.metaKey === Boolean(binding.mod && apple) &&
    event.altKey === Boolean(binding.alt) &&
    (event.shiftKey === Boolean(binding.shift) || (binding.key === '/' && event.key === '/')),
  );
}

export function shortcutKeys(action: Shortcut, apple: boolean): string[] {
  const binding: Binding = shortcuts[action];
  const names: Record<string, string> = {
    Backspace: apple ? '⌫' : 'Backspace',
    ArrowUp: '↑',
    ArrowDown: '↓',
  };
  return [
    ...(binding.mod ? [apple ? 'Cmd' : 'Ctrl'] : []),
    ...(binding.alt ? [apple ? 'Option' : 'Alt'] : []),
    ...(binding.shift ? ['Shift'] : []),
    names[binding.key] ?? binding.key.toUpperCase(),
  ];
}

export function shortcutAria(action: Shortcut, apple: boolean) {
  const binding: Binding = shortcuts[action];
  return [
    ...(binding.mod ? [apple ? 'Meta' : 'Control'] : []),
    ...(binding.alt ? ['Alt'] : []),
    ...(binding.shift ? ['Shift'] : []),
    binding.key.length === 1 ? binding.key.toUpperCase() : binding.key,
  ].join('+');
}

export function shortcutAllowed(
  action: Shortcut,
  context: {
    enabled: boolean;
    composing: boolean;
    repeated: boolean;
    overlay: boolean;
    editing: boolean;
    helpOpen: boolean;
  },
) {
  if (!context.enabled || context.composing || context.repeated) return false;
  if (context.overlay && !(action === 'showShortcuts' && context.helpOpen)) return false;
  return !((action === 'previousSession' || action === 'nextSession') && context.editing);
}

/** Navigation follows the displayed order, never wraps or guesses at unloaded rows. */
export function adjacentSession(ids: string[], current: string | undefined, direction: -1 | 1) {
  if (!current) return undefined;
  const index = ids.indexOf(current);
  return index < 0 ? undefined : ids[index + direction];
}
