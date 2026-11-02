import { useSyncExternalStore } from 'react';
import { useRuntime } from '../connections/context';
import type { ConnectionRuntime } from '../connections/runtime';
import { EditorStore } from './store';

const stores = new WeakMap<ConnectionRuntime, EditorStore>();

/**
 * The files open in editors, for this page, read again whenever they change: see
 * {@link editorStore}.
 */
export function useEditorStore(): EditorStore {
  const store = editorStore(useRuntime());
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  return store;
}

/**
 * The files open in editors, for this page, for what changes them without showing them. Signing
 * out lets go of them, and waits while one has changes not saved, as leaving the page asks first
 * then.
 */
/** Asks for `count` files with changes, open `where` says, to be saved or closed first. */
export function saveFirst(count: number, where = ''): string | undefined {
  if (!count) return undefined;
  const one = count === 1;
  return `${one ? 'An open file' : `${count} open files`}${where} ${one ? 'has' : 'have'} changes not saved. Save or close ${one ? 'it' : 'them'} first.`;
}

export function editorStore(runtime: ConnectionRuntime): EditorStore {
  let store = stores.get(runtime);
  if (!store) {
    // Each place's tabs, and where each file was, are kept in this browser for a reload.
    const made = new EditorStore(runtime.gateway, {
      read: (place) => runtime.storage.workspace(place),
      write: (place, tabs, active) => runtime.storage.saveWorkspace(place, { tabs, active }),
      forget: (places) => runtime.storage.forgetWorkspaces(places),
      view: (path) => runtime.storage.editorView(path),
      writeView: (path, view) => runtime.storage.saveEditorView(path, view),
    });
    runtime.onSignOut(() => made.forgetAll());
    runtime.guardSignOut(() => saveFirst(made.dirty().length));
    window.addEventListener('beforeunload', (event) => {
      if (made.dirty().length) event.preventDefault();
    });
    stores.set(runtime, (store = made));
  }
  return store;
}
