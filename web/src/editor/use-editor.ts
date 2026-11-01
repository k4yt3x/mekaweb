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
export function editorStore(runtime: ConnectionRuntime): EditorStore {
  let store = stores.get(runtime);
  if (!store) {
    const made = new EditorStore(runtime.gateway);
    runtime.onSignOut(() => made.forgetAll());
    runtime.guardSignOut(() => {
      const count = made.dirty().length;
      return count
        ? `${count === 1 ? 'An open file has' : `${count} open files have`} changes not saved. Save or close ${count === 1 ? 'it' : 'them'} first.`
        : undefined;
    });
    window.addEventListener('beforeunload', (event) => {
      if (made.dirty().length) event.preventDefault();
    });
    stores.set(runtime, (store = made));
  }
  return store;
}
