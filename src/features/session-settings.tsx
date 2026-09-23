import { useState, type FormEvent, type ReactNode } from 'react';
import { useAction } from '../components/actions';
import { useCan, useConnection, useResource } from '../connections/context';
import type { Schema } from '../api/client';
import { Field, ErrorNotice } from '../components/common';
import { Button } from '../components/ui/button';
import type { ComposerOptions } from '../session/controller';

export type TurnSettings = Pick<ComposerOptions, 'mode' | 'skill' | 'retention' | 'source'>;

export function ComposerSettingsForm({
  session,
  options,
  hasImages,
  running,
  onSaved,
}: {
  session: Schema['SessionResponse'];
  options: TurnSettings;
  hasImages: boolean;
  running: boolean;
  onSaved: (options: TurnSettings) => void;
}) {
  const [draft, setDraft] = useState(options);
  const canWrite = useCan('sessions:w') && !session.parent_id;
  const skills = useResource<Schema['SkillView'][]>('/v1/skills');
  const direct = hasImages || Boolean(draft.skill) || draft.retention !== 'keep';
  return (
    <SessionForm session={session} running={running} onSaved={() => onSaved(draft)}>
      <Field
        label="While the agent is working"
        hint={direct ? 'Unavailable with the selected delivery options.' : undefined}
      >
        <select
          value={draft.mode}
          disabled={direct || !canWrite}
          onChange={(event) => setDraft({ ...draft, mode: event.target.value })}
        >
          <option value="steer">Steer</option>
          <option value="followup">Queue</option>
          <option value="interrupt">Interrupt and send</option>
        </select>
      </Field>
      <Field label="Activate skill">
        <select
          value={draft.skill}
          disabled={!canWrite}
          onChange={(event) => setDraft({ ...draft, skill: event.target.value })}
        >
          <option value="">No skill</option>
          {draft.skill && !skills.data?.some((skill) => skill.name === draft.skill) && (
            <option value={draft.skill}>{draft.skill}</option>
          )}
          {skills.data?.map((skill) => (
            <option key={skill.name} value={skill.name}>
              {skill.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Unanswered direct-turn message">
        <select
          value={draft.retention}
          disabled={!canWrite}
          onChange={(event) => setDraft({ ...draft, retention: event.target.value })}
        >
          <option value="keep">Keep (server default)</option>
          <option value="withdraw">Withdraw</option>
        </select>
      </Field>
      <Field label="Inbox source">
        <input
          value={draft.source}
          placeholder="Server default"
          disabled={direct || !canWrite}
          onChange={(event) => setDraft({ ...draft, source: event.target.value })}
        />
      </Field>
      <ErrorNotice error={skills.error} />
    </SessionForm>
  );
}

export function SessionForm({
  session,
  onSaved,
  children,
  running = false,
}: {
  session?: Schema['SessionResponse'];
  onSaved: (id: string) => void;
  children?: ReactNode;
  running?: boolean;
}) {
  const { api, info, controller } = useConnection();
  const profiles = useResource<Schema['ProfilesResponse']>('/v1/profiles', undefined, !session);
  const [initial] = useState(session);
  const canWrite = useCan('sessions:w') && !session?.parent_id;
  const activeTurn = running || session?.turn_in_flight;
  const [cwd, setCwd] = useState(session?.cwd ?? '');
  const [profile, setProfile] = useState(session?.profile ?? '');
  const [permission, setPermission] = useState(session?.permission ?? '');
  const [approvals, setApprovals] = useState(session ? String(session.approvals) : '');
  const [reasoning, setReasoning] = useState(true);
  const [prompts, setPrompts] = useState(true);
  const action = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!api) return;
      let response: Schema['SessionResponse'];
      if (session) {
        const body: Schema['PatchSessionRequest'] = {
          ...(cwd !== (initial?.cwd ?? '') ? { cwd } : {}),
          ...(approvals !== String(initial?.approvals) ? { approvals: approvals === 'true' } : {}),
        };
        if (!controller) throw new Error('Reconnect before changing session settings.');
        response = Object.keys(body).length
          ? await controller.patchSettings(session.id, body)
          : session;
      } else
        response = await api.mutate('POST', '/v1/sessions', {
          ...(cwd ? { cwd } : {}),
          ...(profile ? { profile } : {}),
          ...(permission ? { permission } : {}),
          ...(approvals ? { approvals: approvals === 'true' } : {}),
          capabilities: {
            supports_permission_prompts: prompts,
            supports_reasoning_stream: reasoning,
          },
        } satisfies Schema['CreateSessionRequest']);
      onSaved(response.id);
    });
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <fieldset className="form-stack" disabled={action.busy}>
        <Field
          label="Working directory"
          hint={activeTurn ? 'Directory is locked during a turn.' : undefined}
        >
          <input
            value={cwd}
            disabled={!canWrite || activeTurn}
            onChange={(event) => setCwd(event.target.value)}
            placeholder="Server default"
          />
        </Field>
        {!session && (
          <Field label="Profile">
            <select
              value={profile}
              disabled={!canWrite || activeTurn}
              onChange={(event) => setProfile(event.target.value)}
            >
              <option value="">Server default</option>
              {profiles.data?.profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} · {p.model ?? 'No model'}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className={session ? undefined : 'form-grid'}>
          {!session && (
            <Field label="Permission">
              <select
                value={permission}
                disabled={!canWrite}
                onChange={(event) => setPermission(event.target.value)}
              >
                <option value="">Server default ({info?.default_permission})</option>
                {info?.enabled_permissions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Approval mode">
            <select
              value={approvals}
              disabled={!canWrite}
              onChange={(event) => setApprovals(event.target.value)}
            >
              {!session && <option value="">Server default</option>}
              <option value="true">Ask for approval</option>
              <option value="false">Deny above permission level</option>
            </select>
          </Field>
        </div>
        {!session && (
          <details>
            <summary>Session capabilities</summary>
            <label className="check">
              <input
                type="checkbox"
                checked={reasoning}
                onChange={(event) => setReasoning(event.target.checked)}
              />
              Receive reasoning when available
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={prompts}
                onChange={(event) => setPrompts(event.target.checked)}
              />
              Support permission prompts
            </label>
          </details>
        )}
        {children}
        <ErrorNotice error={action.error ?? (!session ? profiles.error : undefined)} />
        <Button type="submit" disabled={action.busy || !canWrite}>
          {action.busy ? 'Saving…' : session ? 'Save settings' : 'Create session'}
        </Button>
      </fieldset>
    </form>
  );
}
