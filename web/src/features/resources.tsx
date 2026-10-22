import { useAction } from '../components/actions';
import { useState, type FormEvent } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { useCan, useConnection, useResource, useRuntime } from '../connections/context';
import { segment, type Schema } from '../api/client';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { ConfirmButton, Empty, ErrorNotice, Field, Json, Loading } from '../components/common';
import { Markdown } from '../components/markdown';
import { SwitchField } from '../components/ui/switch';
type Kind = 'memory' | 'skills';
type Detail = Schema['MemoryDetail'] | Schema['SkillDetail'];
export function ResourcesPage({ kind }: { kind: Kind }) {
  const { api, connection } = useConnection();
  const runtime = useRuntime();
  const canWrite = useCan(kind + ':w');
  const canRead = useCan(kind + ':r');
  const memories = useResource<Schema['MemoryListResponse']>(
    '/v1/memory',
    undefined,
    kind === 'memory' && canRead,
  );
  // meka decides what has expired, by its own clock and time zone.
  const expired = useResource<Schema['MemoryListResponse']>(
    '/v1/memory',
    { expired: true },
    kind === 'memory' && canRead,
  );
  const expiredNames = new Set(expired.data?.memories.map((memory) => memory.name));
  const skills = useResource<Schema['SkillView'][]>('/v1/skills', undefined, kind === 'skills');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  const detail = useResource<Detail>(
    `/v1/${kind}/${segment(selected ?? '_')}`,
    undefined,
    Boolean(selected) && canRead,
  );
  const list = kind === 'memory' ? memories.data?.memories : skills.data;
  const rows = list?.filter((item) =>
    [
      item.name,
      item.description,
      ...('tags' in item ? [...item.tags, item.source, ...item.references] : []),
    ]
      .join(' ')
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const title = kind === 'memory' ? 'Memory' : 'Skills';
  function open(name: string) {
    runtime.queries.removeQueries({
      queryKey: [connection?.id, connection?.authority, `/v1/${kind}/${segment(name)}`],
    });
    setSelected(name);
  }
  return (
    <div className="page">
      <header className="page-heading">
        <div>
          <h1>{title}</h1>
        </div>
        <Button
          disabled={!canWrite}
          title={!canWrite ? `Requires ${kind}:w` : undefined}
          onClick={() => setCreating(true)}
        >
          <Plus size={16} />
          New {kind === 'memory' ? 'memory' : 'skill'}
        </Button>
      </header>
      <label className="search">
        <Search size={17} />
        <input
          aria-label={`Search ${title.toLowerCase()}`}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={`Search ${title.toLowerCase()}…`}
        />
      </label>
      <ErrorNotice error={kind === 'memory' ? memories.error : skills.error} />
      {!list && (memories.isFetching || skills.isFetching) && <Loading />}
      <div className="resource-grid">
        {rows?.map((item) => (
          <button
            className="resource-card"
            key={item.name}
            onClick={() => open(item.name)}
            disabled={!canRead}
          >
            <h2>{item.name}</h2>
            <p>{item.description}</p>
            <div className="card-meta">
              <span>Priority {item.priority}</span>
              {'load' in item && item.load !== 'index' && (
                <span className="badge">{loads[item.load] ?? item.load}</span>
              )}
              {expiredNames.has(item.name) && <span className="badge">Expired</span>}
              {'tags' in item &&
                item.tags.map((tag) => (
                  <span className="tag" key={tag}>
                    {tag}
                  </span>
                ))}
            </div>
          </button>
        ))}
      </div>
      {rows?.length === 0 && (
        <Empty title={filter ? 'No matching entries' : `No ${title.toLowerCase()} yet`} />
      )}
      {!canRead && (
        <p className="muted">
          {kind === 'skills'
            ? 'Reading skill bodies requires skills:r.'
            : 'Reading memories requires memory:r.'}
        </p>
      )}
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
        title={selected ?? title}
        wide
      >
        {detail.isPending ? <Loading /> : <ErrorNotice error={detail.error} />}{' '}
        {detail.data && (
          <ResourceEditor
            key={kind + selected}
            kind={kind}
            initial={detail.data}
            canWrite={canWrite}
            onOpen={open}
            onSaved={async () => {
              await runtime.queries.invalidateQueries();
              setSelected(undefined);
            }}
          />
        )}
        {selected && canWrite && (
          <ConfirmButton
            title={`Delete ${kind === 'memory' ? 'memory' : 'skill'}`}
            description="This removes the server resource. Other sessions may depend on it."
            onConfirm={async () => {
              await api?.mutate('DELETE', `/v1/${kind}/${segment(selected)}`);
              await runtime.queries.invalidateQueries();
              setSelected(undefined);
            }}
          >
            <Trash2 size={15} />
            Delete
          </ConfirmButton>
        )}
      </Dialog>
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title={`New ${kind === 'memory' ? 'memory' : 'skill'}`}
        wide
      >
        {creating && (
          <ResourceEditor
            kind={kind}
            canWrite={canWrite}
            onSaved={async () => {
              await runtime.queries.invalidateQueries();
              setCreating(false);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
/** How a memory reaches the agent's context, by meka's `load`. */
const loads: Readonly<Record<string, string>> = {
  inline: 'Inline',
  index: 'Index',
  search: 'Search only',
};
/** The last day a memory applies, in this browser's time zone; meka stores when it stops. */
function lastDay(expiresAt: string | null | undefined) {
  if (!expiresAt) return '';
  const day = new Date(Date.parse(expiresAt) - 1);
  return [day.getFullYear(), day.getMonth() + 1, day.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
}
function ResourceEditor({
  kind,
  initial,
  canWrite,
  onSaved,
  onOpen,
}: {
  kind: Kind;
  initial?: Detail;
  canWrite: boolean;
  onSaved: () => void | Promise<void>;
  onOpen?: (name: string) => void;
}) {
  const { api } = useConnection();
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [priority, setPriority] = useState(initial ? String(initial.priority) : '');
  const [tags, setTags] = useState(initial && 'tags' in initial ? initial.tags.join(', ') : '');
  const [author, setAuthor] = useState(
    initial && 'author' in initial ? (initial.author ?? '') : '',
  );
  const memory = initial && 'load' in initial ? initial : undefined;
  const [load, setLoad] = useState(memory?.load ?? 'index');
  const [expires, setExpires] = useState(() => lastDay(memory?.expires_at));
  const [source, setSource] = useState(memory?.source ?? '');
  const [references, setReferences] = useState(memory?.references.join('\n') ?? '');
  const [verified, setVerified] = useState(false);
  const [preview, setPreview] = useState(false);
  const action = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!api) return;
      const changedBody = !initial || body !== (initial.body ?? '');
      const changedPriority =
        priority !== '' && (!initial || Number(priority) !== initial.priority);
      const base = {
        description,
        ...(changedBody ? { body } : {}),
        ...(changedPriority ? { priority: Number(priority) } : {}),
      };
      if (kind === 'memory') {
        const values = tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean);
        if (values.length > 10 || values.some((tag) => !/^[a-z0-9-]+$/.test(tag)))
          throw new Error('Use at most 10 lowercase tags containing letters, numbers, or hyphens.');
        const original = initial && 'tags' in initial ? initial.tags : [];
        const cited = references
          .split('\n')
          .map((reference) => reference.trim())
          .filter(Boolean);
        if (cited.length > 20) throw new Error('Use at most 20 references, one per line.');
        // Each is sent only when changed, so a save cannot move what it did not touch, such as
        // an expiry meka stores as the moment after the day it was given.
        await api.mutate('PUT', `/v1/memory/${segment(name)}`, {
          ...base,
          ...(JSON.stringify(values) !== JSON.stringify(original) ? { tags: values } : {}),
          ...(load !== (memory?.load ?? 'index') ? { load } : {}),
          ...(expires !== lastDay(memory?.expires_at) ? { expires } : {}),
          ...(source !== (memory?.source ?? '') ? { source } : {}),
          ...(JSON.stringify(cited) !== JSON.stringify(memory?.references ?? [])
            ? { references: cited }
            : {}),
          ...(verified ? { verified } : {}),
        } satisfies Schema['WriteMemoryRequest']);
      } else
        await api.mutate('PUT', `/v1/skills/${segment(name)}`, {
          ...base,
          ...(!initial && author ? { author } : {}),
        } satisfies Schema['WriteSkillRequest']);
      await onSaved();
    });
  }
  return (
    <form className="form-stack" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={!canWrite || action.busy}>
        <div className="form-grid">
          <Field label="Name">
            <input
              required
              value={name}
              disabled={Boolean(initial)}
              onChange={(event) => setName(event.target.value)}
              pattern="[a-zA-Z0-9_-]+"
              placeholder="project-conventions"
            />
          </Field>
          <Field label="Priority">
            <input
              type="number"
              min="0"
              max="9"
              placeholder={initial ? 'Unchanged' : 'Server default'}
              title="0 is highest; 9 is lowest"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </Field>
        </div>
        {kind === 'memory' && (
          <div className="form-grid">
            <Field label="Load">
              <select value={load} onChange={(event) => setLoad(event.target.value)}>
                <option value="index">Index: listed by description</option>
                <option value="inline">Inline: whole body every turn</option>
                <option value="search">Search only</option>
              </select>
            </Field>
            <Field label="Expires" hint="The last day it applies, by the server's time zone.">
              <input
                type="date"
                value={expires}
                onChange={(event) => setExpires(event.target.value)}
              />
            </Field>
          </div>
        )}
        <Field label="Description">
          <input
            required
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        {kind === 'memory' ? (
          <>
            <Field label="Tags">
              <input
                value={tags}
                placeholder="project, preferences"
                onChange={(event) => setTags(event.target.value)}
              />
            </Field>
            <Field label="Source">
              <input
                value={source}
                placeholder="Where the fact came from"
                onChange={(event) => setSource(event.target.value)}
              />
            </Field>
            <Field label="References" hint="Memory names, paths, URLs, or IDs, one per line.">
              <textarea
                rows={2}
                value={references}
                onChange={(event) => setReferences(event.target.value)}
                spellCheck={false}
              />
            </Field>
            {memory && (
              <SwitchField
                label={`Mark as verified (last verified ${new Date(memory.verified_at).toLocaleDateString()})`}
                checked={verified}
                onCheckedChange={setVerified}
              />
            )}
          </>
        ) : (
          <Field label="Author">
            <input
              value={author}
              title={initial ? 'Set at creation' : undefined}
              disabled={Boolean(initial)}
              onChange={(event) => setAuthor(event.target.value)}
            />
          </Field>
        )}
      </fieldset>
      {memory?.referenced_by?.length ? (
        <div className="card-meta">
          <span className="muted small">Referenced by</span>
          {memory.referenced_by.map((name) => (
            <Button key={name} size="sm" variant="secondary" onClick={() => onOpen?.(name)}>
              {name}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="editor-tabs">
        <Button
          variant={!preview ? 'secondary' : 'ghost'}
          aria-pressed={!preview}
          onClick={() => setPreview(false)}
        >
          Source
        </Button>
        <Button
          variant={preview ? 'secondary' : 'ghost'}
          aria-pressed={preview}
          onClick={() => setPreview(true)}
        >
          Preview
        </Button>
      </div>
      {preview ? (
        <div className="editor-preview">
          <Markdown text={body} />
        </div>
      ) : (
        <Field label="Body">
          <textarea
            className="body-editor"
            readOnly={!canWrite}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            spellCheck={false}
          />
        </Field>
      )}
      <ErrorNotice error={action.error} />
      {initial && (
        <details>
          <summary>Server metadata</summary>
          <Json
            value={Object.fromEntries(Object.entries(initial).filter(([key]) => key !== 'body'))}
          />
        </details>
      )}
      <div className="actions">
        {!canWrite && <span className="muted small">Read only. Editing requires {kind}:w.</span>}
        {canWrite && (
          <Button type="submit" disabled={action.busy}>
            {action.busy ? 'Saving…' : 'Save changes'}
          </Button>
        )}
      </div>
    </form>
  );
}
