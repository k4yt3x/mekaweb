import { useState, type FormEvent } from 'react';
import { FolderKanban, Pencil, Plus, Trash2 } from 'lucide-react';
import { useAction } from '../components/actions';
import { useCan, useConnection, useRuntime } from '../connections/context';
import { segment, type Schema } from '../api/client';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { ConfirmButton, Empty, ErrorNotice, Field, Loading, Timestamp } from '../components/common';
import { useProjects } from './projects-query';

export function ProjectsPage() {
  const { api } = useConnection();
  const runtime = useRuntime();
  // A project is a memory tier, so meka writes projects under the memory scope.
  const canWrite = useCan('memory:w');
  const projects = useProjects();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  return (
    <div className="page">
      <header className="page-heading">
        <h1>Projects</h1>
        <Button
          disabled={!canWrite}
          title={!canWrite ? 'Requires memory:w' : undefined}
          onClick={() => setCreating(true)}
        >
          <Plus size={16} />
          New project
        </Button>
      </header>
      <ErrorNotice error={projects.error} />
      {projects.isFetching && !projects.data && <Loading />}
      <div className="stack">
        {projects.data?.projects.map((project) => (
          <article className="panel project-card" key={project.name}>
            <header className="card-heading">
              <FolderKanban size={19} />
              <h2>{project.name}</h2>
            </header>
            <dl className="facts">
              <dt>Memories</dt>
              <dd>{project.memories}</dd>
              <dt>Sessions</dt>
              <dd>{project.sessions}</dd>
              <dt>Added</dt>
              <dd>
                <Timestamp value={project.created_at} />
              </dd>
            </dl>
            <div className="actions">
              <Button
                variant="ghost"
                disabled={!canWrite}
                onClick={() => setRenaming(project.name)}
              >
                <Pencil size={15} />
                Rename
              </Button>
              <ConfirmButton
                disabled={!canWrite}
                title="Remove project"
                description="meka removes a project only once no memory or session is on it."
                onConfirm={async () => {
                  await api?.mutate('DELETE', `/v1/projects/${segment(project.name)}`);
                  await runtime.queries.invalidateQueries();
                }}
              >
                <Trash2 size={15} />
                Remove
              </ConfirmButton>
            </div>
          </article>
        ))}
      </div>
      {projects.data?.projects.length === 0 && <Empty title="No projects yet" />}
      <Dialog open={creating} onOpenChange={setCreating} title="New project">
        {creating && (
          <ProjectForm
            onSaved={async () => {
              await runtime.queries.invalidateQueries();
              setCreating(false);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={renaming !== undefined}
        onOpenChange={(open) => {
          if (!open) setRenaming(undefined);
        }}
        title="Rename project"
        description="Its sessions and memories move with it."
      >
        {renaming !== undefined && (
          <ProjectForm
            initial={renaming}
            onSaved={async () => {
              await runtime.queries.invalidateQueries();
              setRenaming(undefined);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

function ProjectForm({ initial, onSaved }: { initial?: string; onSaved: () => Promise<void> }) {
  const { api } = useConnection();
  const [name, setName] = useState(initial ?? '');
  const action = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!api) return;
      const body = { name } satisfies Schema['ProjectNameRequest'];
      if (initial === undefined) await api.mutate('POST', '/v1/projects', body);
      else if (name !== initial)
        await api.mutate('PATCH', `/v1/projects/${segment(initial)}`, body);
      await onSaved();
    });
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <fieldset className="form-stack" disabled={action.busy}>
        <Field label="Name" hint="Letters, digits, hyphens, and underscores.">
          <input
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            pattern="[A-Za-z0-9][A-Za-z0-9_\-]*"
            placeholder="webdev"
          />
        </Field>
        <ErrorNotice error={action.error} />
        <div className="actions">
          <Button type="submit" disabled={action.busy}>
            {action.busy ? 'Saving…' : initial === undefined ? 'Add project' : 'Rename'}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
