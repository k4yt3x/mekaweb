import { useAction } from '../components/actions';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { useCan, useConnection, useResource, useRuntime } from '../connections/context';
import { segment, type Schema } from '../api/client';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { ConfirmButton, Empty, ErrorNotice, Field, Json, Loading } from '../components/common';
import { Markdown } from '../components/markdown';
import { SwitchField } from '../components/ui/switch';
import { projectNames, useProjects } from './projects-query';
type Kind = 'memory' | 'skills';
type Detail = Schema['MemoryDetail'] | Schema['SkillDetail'];
/** Where an entry is: meka 0.84 lets projects share a memory name, so a name alone is ambiguous. */
interface Entry {
  name: string;
  project: string;
}
/** The project of a memory, or `""` for the global tier or a skill. */
function tier(item: Schema['MemoryDetail'] | Schema['SkillView'] | Schema['SkillDetail']) {
  return ('project' in item && item.project) || '';
}
export function ResourcesPage({ kind }: { kind: Kind }) {
  const { api, connection } = useConnection();
  const runtime = useRuntime();
  const canWrite = useCan(kind + ':w');
  const canRead = useCan(kind + ':r');
  const projects = useProjects(kind === 'memory');
  const tiers = projectNames(projects.data);
  // Every tier, `""` the global one, or a project's.
  const [tierFilter, setTierFilter] = useState<string>();
  const tierScope = tierFilter === undefined ? {} : { project: tierFilter };
  const [filter, setFilter] = useState('');
  const query = filter.trim();
  const [words, setWords] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => setWords(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  // meka searches memory as the agent's `memory_search` does, bodies included, best match first.
  const memories = useResource<Schema['MemoryListResponse']>(
    '/v1/memory',
    { ...tierScope, ...(words ? { q: words, limit: SEARCH_LIMIT } : {}) },
    kind === 'memory' && canRead,
  );
  // meka decides what has expired, by its own clock and time zone.
  const expired = useResource<Schema['MemoryListResponse']>(
    '/v1/memory',
    { expired: true, ...tierScope },
    kind === 'memory' && canRead,
  );
  // Neither a project nor a memory name holds `/`.
  const expiredNames = new Set(
    expired.data?.memories.map((memory) => `${tier(memory)}/${memory.name}`),
  );
  const skills = useResource<Schema['SkillView'][]>('/v1/skills', undefined, kind === 'skills');
  const [selected, setSelected] = useState<Entry>();
  const [creating, setCreating] = useState(false);
  // Only a project memory needs its tier named: a global memory's name is in no project.
  const tierQuery = selected?.project ? { project: selected.project } : undefined;
  const detail = useResource<Detail>(
    `/v1/${kind}/${segment(selected?.name ?? '_')}`,
    tierQuery,
    Boolean(selected) && canRead,
  );
  const list = kind === 'memory' ? memories.data?.memories : skills.data;
  // meka cannot search skills, so the shown ones are filtered by name and description.
  const rows =
    kind === 'memory'
      ? list
      : list?.filter((item) =>
          [item.name, item.description].join(' ').toLowerCase().includes(query.toLowerCase()),
        );
  const title = kind === 'memory' ? 'Memory' : 'Skills';
  function open(entry: Entry) {
    runtime.queries.removeQueries({
      queryKey: [connection?.id, connection?.authority, `/v1/${kind}/${segment(entry.name)}`],
    });
    setSelected(entry);
  }
  /** A memory that cites the open one, which is in its tier or the global one. */
  async function openCiting(name: string) {
    const cited = selected;
    if (!cited) return;
    // The shown list may be filtered or searched, so ask meka which memories cite this one.
    const citing = await api
      ?.get<Schema['MemoryListResponse']>('/v1/memory', { referencing: cited.name })
      .then((list) => list.memories.filter((memory) => memory.name === name))
      .catch(() => undefined);
    const found =
      citing?.find((memory) => !cited.project || !tier(memory) || tier(memory) === cited.project) ??
      citing?.[0];
    open({ name, project: found ? tier(found) : '' });
  }
  const remove = canWrite && selected && (
    <ConfirmButton
      title={`Delete ${kind === 'memory' ? 'memory' : 'skill'}`}
      description="This removes the server resource. Other sessions may depend on it."
      onConfirm={async () => {
        await api?.mutate(
          'DELETE',
          `/v1/${kind}/${segment(selected.name)}`,
          undefined,
          undefined,
          undefined,
          tierQuery,
        );
        await runtime.queries.invalidateQueries();
        setSelected(undefined);
      }}
    >
      <Trash2 size={15} />
      Delete
    </ConfirmButton>
  );
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
      <div className="resource-filters">
        <label className="search">
          <Search size={17} />
          <input
            aria-label={`Search ${title.toLowerCase()}`}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={`Search ${title.toLowerCase()}…`}
          />
        </label>
        {kind === 'memory' && (
          <select
            aria-label="Project"
            value={tierFilter ?? ALL_TIERS}
            onChange={(event) =>
              setTierFilter(event.target.value === ALL_TIERS ? undefined : event.target.value)
            }
          >
            <option value={ALL_TIERS}>All projects</option>
            <option value="">Global</option>
            {tiers.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>
      <ErrorNotice error={kind === 'memory' ? memories.error : skills.error} />
      {!list && (memories.isFetching || skills.isFetching) && <Loading />}
      <div className="resource-grid">
        {rows?.map((item) => (
          <button
            className="resource-card"
            key={`${tier(item)}/${item.name}`}
            onClick={() => open({ name: item.name, project: tier(item) })}
            disabled={!canRead}
          >
            <h2>{item.name}</h2>
            <p>{item.description}</p>
            {'snippet' in item && item.snippet && (
              <p className="resource-snippet">{item.snippet}</p>
            )}
            <div className="card-meta">
              <span>Priority {item.priority}</span>
              {tier(item) && <span className="badge">{tier(item)}</span>}
              {'load' in item && item.load !== 'index' && (
                <span className="badge">{loads[item.load] ?? item.load}</span>
              )}
              {expiredNames.has(`${tier(item)}/${item.name}`) && (
                <span className="badge">Expired</span>
              )}
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
      {kind === 'memory' && words && rows?.length === SEARCH_LIMIT && (
        <p className="muted small">Top {SEARCH_LIMIT} matches. Refine your search to find more.</p>
      )}
      {rows?.length === 0 && (
        <Empty
          title={
            query || tierFilter !== undefined
              ? 'No matching entries'
              : `No ${title.toLowerCase()} yet`
          }
        />
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
        title={selected?.name ?? title}
        wide
      >
        {detail.isPending ? <Loading /> : <ErrorNotice error={detail.error} />}{' '}
        {detail.data ? (
          <ResourceEditor
            key={`${kind}/${selected?.project}/${selected?.name}`}
            kind={kind}
            initial={detail.data}
            canWrite={canWrite}
            projects={tiers}
            onOpen={(name) => void openCiting(name)}
            remove={remove}
            onSaved={async () => {
              await runtime.queries.invalidateQueries();
              setSelected(undefined);
            }}
          />
        ) : (
          // An entry that cannot be read can still be deleted.
          detail.error && remove
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
            projects={tiers}
            defaultProject={tierFilter ?? ''}
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
// No project name holds `*`.
const ALL_TIERS = '*';
/** The most matches meka's memory search returns. */
const SEARCH_LIMIT = 25;
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
  projects = [],
  defaultProject = '',
  onSaved,
  onOpen,
  remove,
}: {
  kind: Kind;
  initial?: Detail;
  canWrite: boolean;
  /** The projects a new memory may be filed in. */
  projects?: string[];
  /** The project a new memory starts in, `""` for the global tier. */
  defaultProject?: string;
  onSaved: () => void | Promise<void>;
  onOpen?: (name: string) => void;
  /** Deletes the entry, beside Save. */
  remove?: ReactNode;
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
  // A project memory's name may be another project's too, so a write names its tier. A memory is
  // filed at creation: meka moves one between the global tier and a project, but naming another
  // project for a project's memory adds a memory there.
  const [project, setProject] = useState(memory?.project ?? defaultProject);
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
          project,
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
              pattern="[a-zA-Z0-9_\-]+"
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
          <Field label="Project">
            <select
              value={project}
              disabled={Boolean(initial)}
              onChange={(event) => setProject(event.target.value)}
            >
              <option value="">Global</option>
              {[...new Set([...projects, project])].filter(Boolean).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
        )}
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
          {/* Memories in two projects can share a name and both cite a global memory. */}
          {[...new Set(memory.referenced_by)].map((name) => (
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
      <div className="actions editor-actions">
        {remove}
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
