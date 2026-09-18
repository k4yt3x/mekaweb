import { useAction } from '../components/actions';
import { useState, type FormEvent } from 'react';
import { CalendarClock, Plus } from 'lucide-react';
import { useCan, useConnection, useResource, useRuntime } from '../connections/context';
import { sessionPath, segment, type Schema } from '../api/client';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import {
  ConfirmButton,
  Empty,
  ErrorNotice,
  Field,
  Json,
  Loading,
  Timestamp,
} from '../components/common';
export function SchedulesPage({ sessionId }: { sessionId?: string }) {
  const { api } = useConnection();
  const runtime = useRuntime();
  const canRead = useCan('schedule:r');
  const canWrite = useCan('schedule:w');
  const [create, setCreate] = useState(false);
  const query = useResource<Schema['ScheduledJobsResponse']>(
    sessionId ? sessionPath(sessionId) + '/schedule' : '/v1/schedule',
    undefined,
    canRead,
  );
  const newSchedule = (
    <Button
      disabled={!canWrite}
      title={!canWrite ? 'Requires schedule:w' : undefined}
      onClick={() => setCreate(true)}
    >
      <Plus size={16} />
      New schedule
    </Button>
  );
  return (
    <div className={sessionId ? 'session-schedules' : 'page'}>
      {!sessionId && (
        <header className="page-heading">
          <h1>Schedules</h1>
          {newSchedule}
        </header>
      )}
      <ErrorNotice error={query.error} />
      {query.isFetching && !query.data && canRead && <Loading />}
      {!canRead && <p className="muted">Listing schedules requires schedule:r.</p>}
      <div className="stack">
        {query.data?.jobs.map((job) => (
          <article className="panel schedule-card" key={job.id}>
            <header>
              <CalendarClock size={19} />
              <h2>
                {job.schedule.startsWith('every ')
                  ? job.schedule.replace(/(\d)(?=[a-z])/gi, '$1 ')
                  : job.schedule}
              </h2>
              {job.gate && <span className="badge">Gated</span>}
            </header>
            <p className="plain-text">{job.prompt}</p>
            <dl className="facts">
              <dt>Next occurrence</dt>
              <dd>
                <Timestamp value={job.next_fire_at} />
              </dd>
              <dt>Last fired</dt>
              <dd>
                <Timestamp value={job.last_fired_at} />
              </dd>
              <dt>Session</dt>
              <dd>
                <a href={`#/sessions/${encodeURIComponent(job.session_id)}`}>{job.session_id}</a>
              </dd>
            </dl>
            {job.withheld && <p className="notice">Withheld: {job.withheld}</p>}
            {job.gate && (
              <div className="notice">
                <div>
                  <strong>
                    {job.gate.kind} gate · {job.gate.when}
                  </strong>
                  <p>{job.gate.check ?? 'Gate details are withheld without sessions:r.'}</p>
                </div>
              </div>
            )}
            <details>
              <summary>Job details</summary>
              <Json value={job} />
            </details>
            <ConfirmButton
              disabled={!canWrite}
              title="Cancel schedule"
              description="Cancel future runs. A running turn will continue."
              onConfirm={async () => {
                await api?.mutate('DELETE', '/v1/schedule/' + segment(job.id));
                await runtime.queries.invalidateQueries();
              }}
            >
              Cancel schedule
            </ConfirmButton>
          </article>
        ))}
      </div>
      {query.data?.jobs.length === 0 && <Empty title="Nothing scheduled" />}
      {sessionId && <div className="schedule-actions">{newSchedule}</div>}
      <Dialog open={create} onOpenChange={setCreate} title="New schedule" wide>
        {create && (
          <ScheduleForm
            sessionId={sessionId}
            onSaved={() => {
              setCreate(false);
              void runtime.queries.invalidateQueries();
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
function ScheduleForm({
  sessionId,
  onSaved,
}: {
  sessionId: string | undefined;
  onSaved: () => void;
}) {
  const { api } = useConnection();
  const [id, setId] = useState(sessionId ?? '');
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState('at');
  const [time, setTime] = useState('');
  const [gate, setGate] = useState('none');
  const [check, setCheck] = useState('');
  const [args, setArgs] = useState('{}');
  const [when, setWhen] = useState('changed');
  const [pattern, setPattern] = useState('');
  const [pointer, setPointer] = useState('');
  const [condition, setCondition] = useState('not_empty');
  const action = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      let gateValue: Schema['CreateGate'] | undefined;
      if (gate !== 'none')
        gateValue = {
          check:
            gate === 'shell'
              ? { command: check }
              : { tool: check, arguments: JSON.parse(args) as unknown },
          when:
            when === 'matches'
              ? { matches: pattern }
              : when === 'pointer'
                ? { at: pointer, is: condition }
                : when,
        };
      await api?.mutate('POST', sessionPath(id) + '/schedule', {
        prompt,
        ...(kind === 'at' ? { at: time } : kind === 'every' ? { every: time } : { cron: time }),
        ...(gateValue ? { gate: gateValue } : {}),
      } satisfies Schema['CreateJobRequest']);
      onSaved();
    });
  }
  return (
    <form className="form-stack" onSubmit={(event) => void submit(event)}>
      <Field label="Session ID">
        <input
          required
          value={id}
          placeholder="Root session ID"
          readOnly={Boolean(sessionId)}
          onChange={(event) => setId(event.target.value)}
        />
      </Field>
      <Field label="Prompt">
        <textarea required value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      </Field>
      <div className="form-grid">
        <Field label="Timing">
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="at">One time</option>
            <option value="every">Repeating interval</option>
            <option value="cron">Cron expression</option>
          </select>
        </Field>
        <Field
          label={kind === 'at' ? 'When' : kind === 'every' ? 'Interval' : 'Cron (server time)'}
        >
          <input
            required
            value={time}
            onChange={(event) => setTime(event.target.value)}
            placeholder={
              kind === 'at'
                ? '20m or RFC 3339 timestamp'
                : kind === 'every'
                  ? '30m or 6h'
                  : '0 9 * * 1-5'
            }
          />
        </Field>
      </div>
      <details>
        <summary>Gate this schedule</summary>
        <div className="form-stack">
          <Field label="Gate type">
            <select value={gate} onChange={(event) => setGate(event.target.value)}>
              <option value="none">No gate</option>
              <option value="shell">Shell command</option>
              <option value="tool">Read-only tool</option>
            </select>
          </Field>
          {gate !== 'none' && (
            <>
              <Field
                label={gate === 'shell' ? 'Command' : 'Tool name'}
                hint={gate === 'shell' ? 'Requires unrestricted permission.' : undefined}
              >
                <input
                  required
                  value={check}
                  placeholder={gate === 'shell' ? 'git status --porcelain' : 'mcp__server__tool'}
                  onChange={(event) => setCheck(event.target.value)}
                />
              </Field>
              {gate === 'tool' && (
                <Field label="Tool arguments (JSON)">
                  <textarea
                    required
                    value={args}
                    onChange={(event) => setArgs(event.target.value)}
                    spellCheck={false}
                  />
                </Field>
              )}
              <Field label="Fire when">
                <select value={when} onChange={(event) => setWhen(event.target.value)}>
                  <option value="changed">Result changes</option>
                  <option value="succeeded">Check succeeds</option>
                  <option value="matches">Output matches a regular expression</option>
                  <option value="pointer">JSON value meets a condition</option>
                </select>
              </Field>
              {when === 'matches' && (
                <Field label="Regular expression">
                  <input
                    required
                    value={pattern}
                    onChange={(event) => setPattern(event.target.value)}
                  />
                </Field>
              )}
              {when === 'pointer' && (
                <>
                  <Field label="JSON pointer">
                    <input
                      value={pointer}
                      onChange={(event) => setPointer(event.target.value)}
                      placeholder="/items"
                    />
                  </Field>
                  <Field label="Condition">
                    <select
                      value={condition}
                      onChange={(event) => setCondition(event.target.value)}
                    >
                      <option value="not_empty">Not empty</option>
                      <option value="empty">Empty</option>
                      <option value="changed">Changed</option>
                    </select>
                  </Field>
                </>
              )}
            </>
          )}
        </div>
      </details>
      <ErrorNotice error={action.error} />
      <Button type="submit" disabled={action.busy}>
        {action.busy ? 'Creating…' : 'Create schedule'}
      </Button>
    </form>
  );
}
