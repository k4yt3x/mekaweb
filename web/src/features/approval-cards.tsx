import { useAction } from '../components/actions';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ExternalLink, MessageCircleQuestion, ShieldCheck } from 'lucide-react';
import { useConnection } from '../connections/context';
import type { Approval } from '../session/controller';
import type { Schema } from '../api/client';
import {
  openableUrl,
  questionContent,
  questionDefaults,
  questionFields,
  type QuestionField,
  type QuestionValues,
} from '../session/elicitation';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { SwitchField } from '../components/ui/switch';
import { ErrorNotice, Field, Json } from '../components/common';

/** How long an approval's buttons wait before they take a tap: one meant for what was under the
 * card as it appeared is not taken for an answer. */
const APPROVAL_ARMING_DELAY = 700;

/** Each prompt has a card of its own, so it arms once, as it appears. */
function useArmed() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), APPROVAL_ARMING_DELAY);
    return () => clearTimeout(timer);
  }, []);
  return armed;
}

export function PromptCard({ approval }: { approval: Approval }) {
  return approval.kind === 'permission' ? (
    <ApprovalCard approval={approval} />
  ) : (
    <QuestionCard question={approval} />
  );
}

function Origin({ approval }: { approval: Approval }) {
  return (
    <p className="muted small">
      <a href={`#/sessions/${encodeURIComponent(approval.sessionId)}`}>
        Session {approval.sessionId.slice(0, 8)}
      </a>
      {approval.subagentId && (
        <>
          {' · '}
          <a href={`#/sessions/${encodeURIComponent(approval.subagentId)}`}>
            Sub-agent {approval.subagentId.slice(0, 8)}
          </a>
        </>
      )}
    </p>
  );
}

function ApprovalCard({ approval }: { approval: Extract<Approval, { kind: 'permission' }> }) {
  const { controller } = useConnection();
  const action = useAction();
  const armed = useArmed();
  return (
    <section className="approval-card">
      <header>
        <ShieldCheck size={20} />
        <h2>Approval needed</h2>
      </header>
      <Origin approval={approval} />
      <h3>{approval.tool}</h3>
      <details open>
        <summary>Full arguments</summary>
        <Json value={approval.input} />
      </details>
      <p className="muted small">Expires at {new Date(approval.expires).toLocaleTimeString()}.</p>
      <ErrorNotice error={action.error} />
      <div className="approval-actions">
        {(
          [
            ['allow', 'Allow once'],
            ['deny', 'Deny once'],
            ['allow_always', 'Always allow'],
            ['deny_always', 'Always deny'],
          ] satisfies [Schema['ResponseOutcome'], string][]
        ).map(([outcome, label]) => (
          <Button
            key={outcome}
            variant={outcome === 'allow' ? 'default' : 'secondary'}
            size="sm"
            disabled={!armed || action.busy || !controller?.canWrite}
            title={!controller?.canWrite ? 'Requires sessions:w' : undefined}
            onClick={() => void action.run(async () => controller?.respond(approval, outcome))}
          >
            {label}
          </Button>
        ))}
      </div>
    </section>
  );
}

/** An MCP server's question: a form to fill in, or a page to open. */
function QuestionCard({ question }: { question: Exclude<Approval, { kind: 'permission' }> }) {
  const { controller } = useConnection();
  const action = useAction();
  const armed = useArmed();
  const schema = question.kind === 'form' ? question.schema : undefined;
  const fields = useMemo(() => (schema ? questionFields(schema) : []), [schema]);
  const [values, setValues] = useState(() => (schema ? questionDefaults(schema, fields) : {}));
  const [invalid, setInvalid] = useState<string>();
  const disabled = !armed || action.busy || !controller?.canWrite;
  const title = !controller?.canWrite ? 'Requires sessions:w' : undefined;
  const answer = (outcome: Schema['ResponseOutcome'], content?: Record<string, unknown>) =>
    void action.run(async () => controller?.respond(question, outcome, content));
  function submit(event: FormEvent) {
    event.preventDefault();
    const result = questionContent(fields, values);
    setInvalid('error' in result ? result.error : undefined);
    if ('content' in result) answer('accept', result.content);
  }
  const openable = question.kind === 'url' && openableUrl(question.url);
  return (
    <section className="approval-card">
      <header>
        <MessageCircleQuestion size={20} />
        <h2>Question from {question.server}</h2>
      </header>
      <Origin approval={question} />
      <p className="plain-text">{question.message}</p>
      {question.kind === 'url' ? (
        <>
          <code className="question-url">{question.url}</code>
          {!openable && <p className="muted small">Only a web address can be opened from here.</p>}
        </>
      ) : (
        <form id={`question-${question.id}`} className="question-form" onSubmit={submit}>
          {fields.map((field) => (
            <QuestionInput
              key={field.name}
              field={field}
              value={values[field.name]}
              onChange={(value) => setValues((old) => ({ ...old, [field.name]: value }))}
            />
          ))}
        </form>
      )}
      <p className="muted small">Expires at {new Date(question.expires).toLocaleTimeString()}.</p>
      <ErrorNotice error={invalid ? new Error(invalid) : action.error} />
      <div className="approval-actions question-actions">
        {question.kind === 'url' ? (
          // Opening is the consent the server asked for; it learns of the rest from the page.
          <Button
            size="sm"
            disabled={disabled || !openable}
            title={title}
            onClick={() => {
              window.open(question.url, '_blank', 'noopener,noreferrer');
              answer('accept');
            }}
          >
            <ExternalLink size={14} />
            Open
          </Button>
        ) : (
          <Button
            size="sm"
            type="submit"
            form={`question-${question.id}`}
            disabled={disabled}
            title={title}
          >
            Submit
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          title={title}
          onClick={() => answer('decline')}
        >
          Decline
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          title={title}
          onClick={() => answer('cancel')}
        >
          Skip
        </Button>
      </div>
    </section>
  );
}

function QuestionInput({
  field,
  value,
  onChange,
}: {
  field: QuestionField;
  value: QuestionValues[string] | undefined;
  onChange: (value: QuestionValues[string]) => void;
}) {
  const label = field.label;
  if (field.type === 'boolean')
    return (
      <div className="field">
        <SwitchField label={label} checked={value === true} onCheckedChange={onChange} />
        {field.description && <small>{field.description}</small>}
      </div>
    );
  if (field.type === 'choices') {
    const picked = Array.isArray(value) ? value : [];
    return (
      <fieldset className="field question-choices">
        <legend>{label}</legend>
        {field.options.map((option) => (
          <label key={option.value}>
            <Checkbox
              checked={picked.includes(option.value)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...picked, option.value]
                    : picked.filter((name) => name !== option.value),
                )
              }
            />
            {option.label}
          </label>
        ))}
        {field.description && <small>{field.description}</small>}
      </fieldset>
    );
  }
  const text = typeof value === 'string' ? value : '';
  return (
    <Field label={label} hint={field.description}>
      {field.type === 'choice' ? (
        <select value={text} required={field.required} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === 'number' ? (
        <input
          type="number"
          inputMode={field.integer ? 'numeric' : 'decimal'}
          step={field.integer ? 1 : 'any'}
          min={field.minimum}
          max={field.maximum}
          required={field.required}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type={
            field.format === 'email'
              ? 'email'
              : field.format === 'uri'
                ? 'url'
                : field.format === 'date'
                  ? 'date'
                  : field.format === 'date-time'
                    ? 'datetime-local'
                    : 'text'
          }
          minLength={field.minLength}
          maxLength={field.maxLength}
          required={field.required}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}
