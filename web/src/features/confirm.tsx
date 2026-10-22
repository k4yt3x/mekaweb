import { useState } from 'react';
import { useConnection, useRuntime } from '../connections/context';
import { isProblem, type Gateway } from '../api/gateway';
import { ConfirmDialog } from './confirm-dialog';

/** Whether the person confirmed who they are within `seconds`. */
function isFresh(account: Gateway['SessionView'] | undefined, seconds: number): boolean {
  if (!account?.verified_at) return false;
  return Date.now() - Date.parse(account.verified_at) < seconds * 1000 - 5000;
}

/**
 * Runs actions that need the person to have confirmed who they are recently, asking first when
 * they have not: with a passkey where they have one that works here, else with their password.
 * Render the returned dialog.
 */
export function useConfirmed() {
  const runtime = useRuntime();
  const { account } = useConnection();
  const [pending, setPending] = useState<(() => Promise<unknown>) | undefined>();
  const seconds = account?.fresh_seconds ?? 0;
  async function run(action: () => Promise<unknown>) {
    if (isFresh(runtime.getSnapshot().account, seconds)) {
      try {
        return await action();
      } catch (error) {
        // This device's clock thought the confirmation recent; mekaweb's did not.
        if (!isProblem(error, 'verification-required')) throw error;
      }
    }
    setPending(() => action);
    return undefined;
  }
  const dialog = (
    <ConfirmDialog
      open={Boolean(pending)}
      onOpenChange={(open) => {
        if (!open) setPending(undefined);
      }}
      onConfirmed={async () => {
        const action = pending;
        setPending(undefined);
        await action?.();
      }}
    />
  );
  return { run, dialog };
}
