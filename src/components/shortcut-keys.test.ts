import { describe, expect, it } from 'vitest';
import {
  adjacentSession,
  matchesShortcut,
  shortcutAllowed,
  shortcutAria,
  shortcutKeys,
} from './shortcut-keys';

const key = (changes: Partial<KeyboardEvent> = {}) => ({
  key: 'o',
  code: 'KeyO',
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: true,
  ...changes,
});

describe('shortcut matching', () => {
  it('uses the platform modifier and accepts shifted letter case', () => {
    expect(matchesShortcut('newSession', key({ key: 'O' }), false)).toBe(true);
    expect(matchesShortcut('newSession', key(), true)).toBe(false);
    expect(matchesShortcut('newSession', key({ ctrlKey: false, metaKey: true }), true)).toBe(true);
    expect(matchesShortcut('newSession', key({ altKey: true }), false)).toBe(false);
    expect(matchesShortcut('newSession', key({ metaKey: true }), false)).toBe(false);
  });

  it('does not treat word deletion, forward deletion, or plain Backspace as session deletion', () => {
    expect(
      matchesShortcut('deleteSession', key({ key: 'Backspace', code: 'Backspace' }), false),
    ).toBe(true);
    expect(
      matchesShortcut('deleteSession', key({ key: 'Backspace', shiftKey: false }), false),
    ).toBe(false);
    expect(matchesShortcut('deleteSession', key({ key: 'Backspace', ctrlKey: false }), false)).toBe(
      false,
    );
    expect(matchesShortcut('deleteSession', key({ key: 'Delete' }), false)).toBe(false);
  });

  it('recognizes macOS Option-produced characters without hijacking unmodified typing', () => {
    const optionR = key({
      key: '®',
      code: 'KeyR',
      ctrlKey: false,
      metaKey: true,
      altKey: true,
      shiftKey: false,
    });
    expect(matchesShortcut('renameSession', optionR, true)).toBe(true);
    expect(matchesShortcut('renameSession', { ...optionR, metaKey: false }, true)).toBe(false);
    expect(matchesShortcut('renameSession', { ...optionR, shiftKey: true }, true)).toBe(false);
    expect(matchesShortcut('renameSession', { ...optionR, code: 'KeyP' }, true)).toBe(false);
  });

  it('follows the typed letter on non-US layouts and supports a shifted slash', () => {
    expect(matchesShortcut('newSession', key({ code: 'KeyQ' }), false)).toBe(true);
    expect(matchesShortcut('newSession', key({ key: 'p' }), false)).toBe(false);
    expect(matchesShortcut('showShortcuts', key({ key: '/', code: 'Digit7' }), false)).toBe(true);
    expect(matchesShortcut('showShortcuts', key({ key: '?', code: 'Slash' }), false)).toBe(false);
    expect(
      matchesShortcut(
        'renameSession',
        key({ key: '®', code: 'KeyR', altKey: true, shiftKey: false }),
        false,
      ),
    ).toBe(false);
  });

  it('requires only Alt for session navigation', () => {
    const up = key({
      key: 'ArrowUp',
      code: 'ArrowUp',
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
    });
    expect(matchesShortcut('previousSession', up, false)).toBe(true);
    expect(matchesShortcut('previousSession', up, true)).toBe(true);
    expect(matchesShortcut('previousSession', { ...up, shiftKey: true }, false)).toBe(false);
    expect(matchesShortcut('nextSession', { ...up, key: 'ArrowDown' }, false)).toBe(true);
  });

  it('provides platform-specific display and accessible keys', () => {
    expect(shortcutKeys('deleteSession', true)).toEqual(['Cmd', 'Shift', '⌫']);
    expect(shortcutAria('deleteSession', true)).toBe('Meta+Shift+Backspace');
    expect(shortcutAria('renameSession', false)).toBe('Control+Alt+R');
    expect(shortcutKeys('previousSession', true)).toEqual(['Option', '↑']);
  });
});

describe('shortcut scope', () => {
  const context = {
    enabled: true,
    composing: false,
    repeated: false,
    overlay: false,
    editing: false,
    helpOpen: false,
  };
  it('blocks disabled, repeated and composing actions', () => {
    for (const patch of [{ enabled: false }, { repeated: true }, { composing: true }])
      expect(shortcutAllowed('deleteSession', { ...context, ...patch })).toBe(false);
  });
  it('gives dialogs and menus priority over session actions', () => {
    for (const action of [
      'deleteSession',
      'newSession',
      'stopTurn',
      'renameSession',
      'searchSessions',
    ] as const)
      expect(shortcutAllowed(action, { ...context, overlay: true })).toBe(false);
    expect(shortcutAllowed('showShortcuts', { ...context, overlay: true })).toBe(false);
    expect(shortcutAllowed('showShortcuts', { ...context, overlay: true, helpOpen: true })).toBe(
      true,
    );
    expect(shortcutAllowed('deleteSession', { ...context, overlay: true, helpOpen: true })).toBe(
      false,
    );
  });
  it('preserves text navigation while permitting explicit composer actions', () => {
    expect(shortcutAllowed('previousSession', { ...context, editing: true })).toBe(false);
    expect(shortcutAllowed('nextSession', { ...context, editing: true })).toBe(false);
    expect(shortcutAllowed('stopTurn', { ...context, editing: true })).toBe(true);
    expect(shortcutAllowed('newSession', { ...context, editing: true })).toBe(true);
  });
});

describe('session navigation order', () => {
  const displayed = ['pinned', 'parent', 'child', 'older'];
  it('uses the displayed order, including subagents', () => {
    expect(adjacentSession(displayed, 'parent', 1)).toBe('child');
    expect(adjacentSession(displayed, 'parent', -1)).toBe('pinned');
  });
  it('does not wrap, or jump to unrelated sessions when the current row is absent', () => {
    expect(adjacentSession(displayed, 'pinned', -1)).toBeUndefined();
    expect(adjacentSession(displayed, 'older', 1)).toBeUndefined();
    expect(adjacentSession(displayed, 'filtered-out', 1)).toBeUndefined();
    expect(adjacentSession(displayed, undefined, 1)).toBeUndefined();
    expect(adjacentSession([], 'parent', 1)).toBeUndefined();
  });
});
