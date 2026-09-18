import { useState } from 'react';
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<unknown>();
  return {
    busy,
    error,
    result,
    setError,
    reset: () => {
      setError(undefined);
      setResult(undefined);
    },
    run: async (action: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      setError(undefined);
      setResult(undefined);
      try {
        const value = await action();
        setResult(value);
        return value;
      } catch (error) {
        setError(error);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
  };
}
