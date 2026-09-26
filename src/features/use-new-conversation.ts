import { useRef, useState } from 'react';
import { useConnection, useRuntime } from '../connections/context';
import { UncertainMutationError, type Schema } from '../api/client';
import type { ComposerOptions } from '../session/controller';
import { emptyComposerOptions, remainingComposerOptions } from '../session/composer-options';

export interface NewSessionSettings {
  cwd: string;
  profile: string;
  permission: string;
  approvals: string;
}

export function useNewConversation(onCreated: (id: string) => void) {
  const { api, controller, connection, info } = useConnection();
  const runtime = useRuntime();
  const [settings, setSettings] = useState<NewSessionSettings>({
    cwd: '',
    profile: '',
    permission: '',
    approvals: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef(false);
  const uncertainRef = useRef(false);
  const active = () => runtime.getSnapshot().controller === controller;
  async function start(message: string, options: ComposerOptions) {
    if (
      pending.current ||
      uncertainRef.current ||
      !api ||
      !controller ||
      !connection ||
      !info?.scopes.includes('sessions:w') ||
      (!message.trim() && !options.images.length && !options.skill)
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    let session: Schema['SessionResponse'];
    try {
      session = await api.mutate<Schema['SessionResponse']>('POST', '/v1/sessions', {
        ...(settings.cwd.trim() ? { cwd: settings.cwd.trim() } : {}),
        ...(settings.profile ? { profile: settings.profile } : {}),
        ...(settings.permission ? { permission: settings.permission } : {}),
        ...(settings.approvals ? { approvals: settings.approvals === 'true' } : {}),
        capabilities: {
          // Reasoning renders collapsed, so there is no reason to withhold it from this client.
          supports_reasoning_stream: true,
          // This client can always answer approvals; whether calls ask is the approval mode's
          // choice. Declining here would only refuse calls while the attending feed reconnects.
          supports_permission_prompts: true,
        },
      } satisfies Schema['CreateSessionRequest']);
    } catch (failure) {
      if (active()) {
        setError(failure);
        uncertainRef.current = failure instanceof UncertainMutationError;
        setUncertain(uncertainRef.current);
      }
      return;
    } finally {
      pending.current = false;
      if (active()) setBusy(false);
    }
    if (!active()) return;
    // Transfer the draft before navigating. A failed first turn stays in this session.
    runtime.storage.saveDraft(connection.id, session.id, message);
    controller.saveDraft(session.id, options);
    const admission = controller.submitInitialMessage(session, message, options);
    controller.saveDraft(
      'new',
      remainingComposerOptions(controller.draft('new') ?? emptyComposerOptions, options),
    );
    onCreated(session.id);
    void runtime.queries.invalidateQueries();
    void admission
      .then((accepted) => {
        if (!accepted || !active()) return;
        runtime.storage.clearSubmittedDraft(connection.id, session.id, message);
        controller.saveDraft(
          session.id,
          remainingComposerOptions(controller.draft(session.id) ?? emptyComposerOptions, options),
        );
      })
      .catch((failure: unknown) => {
        if (active()) setError(failure);
      });
    return session.id;
  }
  return {
    settings,
    setSettings,
    busy,
    error,
    uncertain,
    start,
    acknowledge: () => {
      uncertainRef.current = false;
      setUncertain(false);
      setError(undefined);
    },
  };
}

export type NewConversationState = ReturnType<typeof useNewConversation>;
