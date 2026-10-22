import { useEffect, useRef, useState, type SetStateAction } from 'react';
import type { BrowserStorage, Draft } from '../connections/storage';
export function useTextDraft(storage: BrowserStorage, connectionId: string, sessionId: string) {
  const [initial] = useState(() => storage.draft(connectionId, sessionId));
  const [text, setTextState] = useState(initial?.text ?? '');
  const [conflict, setConflict] = useState<Draft>();
  const current = useRef(text);
  const revision = useRef(initial?.revision);
  const savedText = useRef(initial?.text ?? '');
  function setText(value: SetStateAction<string>) {
    current.current = typeof value === 'function' ? value(current.current) : value;
    setTextState(current.current);
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      const draft = storage.saveDraft(connectionId, sessionId, current.current, revision.current);
      if (draft) {
        revision.current = draft.revision;
        savedText.current = draft.text;
      } else setConflict(storage.draft(connectionId, sessionId));
    }, 400);
    return () => clearTimeout(timer);
  }, [storage, connectionId, sessionId, text]);
  useEffect(() => {
    const flush = () => {
      const saved = storage.saveDraft(connectionId, sessionId, current.current, revision.current);
      if (saved) {
        revision.current = saved.revision;
        savedText.current = saved.text;
      }
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [storage, connectionId, sessionId]);
  useEffect(
    () =>
      storage.subscribe(() => {
        const draft = storage.draft(connectionId, sessionId);
        if (!draft || draft.revision === revision.current) return;
        if (draft.text === current.current || current.current === savedText.current) {
          revision.current = draft.revision;
          savedText.current = draft.text;
          current.current = draft.text;
          setTextState(draft.text);
          setConflict(undefined);
        } else if (draft.text === '' && draft.clearedRevision === revision.current) {
          // An acknowledgment clears the submitted revision, not text typed since submission.
          revision.current = draft.revision;
          savedText.current = '';
          storage.saveDraft(connectionId, sessionId, current.current, revision.current);
        } else setConflict(draft);
      }),
    [storage, connectionId, sessionId],
  );
  return {
    text,
    setText,
    conflict,
    accepted: (submitted: string) => {
      // Acknowledgment can arrive after this composer unmounts. Notify its replacement too.
      storage.clearSubmittedDraft(connectionId, sessionId, submitted);
      setText((value) => (value === submitted ? '' : value));
    },
    resolve: (useOther: boolean) => {
      if (!conflict) return;
      revision.current = conflict.revision;
      savedText.current = conflict.text;
      if (useOther) setText(conflict.text);
      else {
        const saved = storage.saveDraft(connectionId, sessionId, text, revision.current);
        if (!saved) {
          setConflict(storage.draft(connectionId, sessionId));
          return;
        }
        revision.current = saved.revision;
        savedText.current = saved.text;
      }
      setConflict(undefined);
    },
  };
}
