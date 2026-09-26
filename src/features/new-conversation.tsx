import { useState, useSyncExternalStore } from 'react';
import { useCan, useConnection, useResource, useRuntime } from '../connections/context';
import type { Schema } from '../api/client';
import type { ComposerOptions } from '../session/controller';
import { useTextDraft } from '../session/drafts';
import { DEFAULT_INPUT_HEIGHT, emptyComposerOptions } from '../session/composer-options';
import { MessageComposer } from '../components/message-composer';
import { Field, ErrorNotice } from '../components/common';
import { NoticeMessage } from '../components/notice-message';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { useSessionNavigation } from './session-navigation';
import { TurnSettingsFields, type TurnSettings } from './session-settings';
import { WorkingDirectoryPicker } from './working-directory-picker';

const subscribeToNothing = () => () => {};
export function NewConversation() {
  const { controller, connection, info } = useConnection();
  const { storage } = useRuntime();
  const { newConversation: creation, setMobileSessionsOpen } = useSessionNavigation();
  const canWrite = useCan('sessions:w');
  const draft = useTextDraft(storage, connection?.id ?? '', 'new');
  const options =
    useSyncExternalStore(controller?.subscribe ?? subscribeToNothing, () =>
      controller?.draft('new'),
    ) ?? emptyComposerOptions;
  const profiles = useResource<Schema['ProfilesResponse']>('/v1/profiles');
  const [height, setHeight] = useState(DEFAULT_INPUT_HEIGHT);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<unknown>();
  const disabled = !canWrite || creation.busy;
  function updateOptions(patch: Partial<ComposerOptions>) {
    controller?.saveDraft('new', {
      ...(controller.draft('new') ?? emptyComposerOptions),
      ...patch,
    });
  }
  async function send() {
    const message = draft.text;
    const id = await creation.start(message, options);
    if (id) draft.accepted(message);
  }
  return (
    <div className="conversation-wrap new-conversation">
      <div className="conversation-scroll">
        <div className="new-conversation-content">
          <header className="conversation-width new-session-intro">
            <h1>New conversation</h1>
            {!canWrite && <p className="muted small">This connection is read only.</p>}
            {/* The recovery notice explains an unconfirmed creation in place of its generic error. */}
            <ErrorNotice error={creation.uncertain ? undefined : creation.error} />
            <ErrorNotice error={error ?? profiles.error} />
            {creation.uncertain && (
              <div className="new-session-recovery">
                <NoticeMessage
                  notice={{
                    level: 'warning',
                    text: 'Session creation wasn’t confirmed, so the server may have created it. Check the session list before trying again.',
                  }}
                />
                <div className="message-actions">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      storage.layout({ sessionsCollapsed: false });
                      setMobileSessionsOpen(true);
                    }}
                  >
                    Show sessions
                  </Button>
                  <Button size="sm" variant="ghost" onClick={creation.acknowledge}>
                    I reviewed the session list
                  </Button>
                </div>
              </div>
            )}
            {draft.conflict && (
              <div className="notice">
                <div>
                  <p>This draft changed in another tab. Choose which version to keep.</p>
                  <div className="message-actions">
                    <Button size="sm" variant="secondary" onClick={() => draft.resolve(false)}>
                      Keep mine
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => draft.resolve(true)}>
                      Use other tab
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </header>
          <MessageComposer
            text={draft.text}
            onTextChange={draft.setText}
            readOnly={!canWrite}
            pending={creation.busy}
            placeholder={creation.busy ? 'Creating session…' : 'Ask meka to work on something…'}
            focusId="new"
            inputHeight={height}
            onResize={setHeight}
            resizeGeneration={0}
            onError={setError}
            permission={{
              value: creation.settings.permission || info?.default_permission,
              options: info?.enabled_permissions ?? [],
              disabled,
              onChange: (permission) => creation.setSettings({ ...creation.settings, permission }),
            }}
            profile={{
              value:
                creation.settings.profile ||
                profiles.data?.profiles.find((profile) => profile.active)?.name,
              profiles: profiles.data?.profiles ?? [],
              disabled: disabled || !profiles.data?.profiles.length,
              busy: false,
              locked: false,
              onChange: (profile) => creation.setSettings({ ...creation.settings, profile }),
            }}
            attachments={{
              value: options.images,
              disabled,
              onChange: (update) =>
                updateOptions({ images: update(controller?.draft('new')?.images ?? []) }),
            }}
            action={{
              kind: 'send',
              disabled:
                disabled ||
                creation.uncertain ||
                (!draft.text.trim() && !options.images.length && !options.skill),
              busy: creation.busy,
              run: () => void send(),
            }}
            settings={{ disabled, busy: false, open: () => setSettingsOpen(true) }}
          >
            <div className="new-session-context">
              <WorkingDirectoryPicker
                value={creation.settings.cwd}
                disabled={disabled}
                onChange={(cwd) => creation.setSettings({ ...creation.settings, cwd })}
              />
            </div>
            <Dialog open={settingsOpen} onOpenChange={setSettingsOpen} title="Session settings">
              {settingsOpen && (
                <NewSessionOptions
                  approvals={creation.settings.approvals}
                  options={options}
                  disabled={disabled}
                  onSave={(approvals, values) => {
                    creation.setSettings({ ...creation.settings, approvals });
                    updateOptions(values);
                    setSettingsOpen(false);
                  }}
                />
              )}
            </Dialog>
          </MessageComposer>
        </div>
      </div>
    </div>
  );
}

function NewSessionOptions({
  approvals,
  options,
  disabled,
  onSave,
}: {
  approvals: string;
  options: ComposerOptions;
  disabled: boolean;
  onSave: (approvals: string, turn: TurnSettings) => void;
}) {
  const [approval, setApproval] = useState(approvals);
  // Only delivery fields: attachments can change while the dialog is open.
  const [turn, setTurn] = useState<TurnSettings>({
    mode: options.mode,
    skill: options.skill,
    retention: options.retention,
    source: options.source,
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) onSave(approval, turn);
      }}
    >
      <fieldset className="form-stack" disabled={disabled}>
        <Field label="Approval mode">
          <select value={approval} onChange={(event) => setApproval(event.target.value)}>
            <option value="">Server default</option>
            <option value="true">Ask for approval</option>
            <option value="false">Deny above permission level</option>
          </select>
        </Field>
        <TurnSettingsFields
          draft={turn}
          setDraft={(values) => setTurn({ ...turn, ...values })}
          canWrite={!disabled}
          hasImages={options.images.length > 0}
        />
        <Button type="submit">Save settings</Button>
      </fieldset>
    </form>
  );
}
