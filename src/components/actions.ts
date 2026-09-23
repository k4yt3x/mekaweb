import { useState } from 'react';
export function useAction(onError?: (error: unknown) => void) {
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
      onError?.(undefined);
      try {
        const value = await action();
        setResult(value);
        return value;
      } catch (error) {
        setError(error);
        onError?.(error);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
  };
}
