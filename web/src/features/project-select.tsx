import * as Select from '@radix-ui/react-select';
import { useRef, useState } from 'react';
import { Check, ChevronDown, FolderKanban, Plus } from 'lucide-react';
import { Dialog } from '../components/ui/dialog';
import { useOverlayPadding } from '../components/visual-viewport';
import { useCan, useRuntime } from '../connections/context';
import { ProjectForm } from './projects';
import { projectNames, useProjects } from './projects-query';

// Radix takes no empty value, and no project name starts with a hyphen or a plus sign.
const NONE = '-';
const NEW = '+';

/**
 * The project a session is on, or a new one opens on, beside the profile. It offers Meka's projects
 * and, under memory:w, adds one and picks it; with neither to offer, it is not shown.
 */
export function ProjectSelect({
  value,
  disabled,
  busy = false,
  locked = false,
  onChange,
}: {
  value: string;
  disabled: boolean;
  busy?: boolean;
  locked?: boolean;
  onChange: (project: string) => void;
}) {
  const runtime = useRuntime();
  // A project is a memory tier, so Meka adds projects under the memory scope.
  const canCreate = useCan('memory:w');
  const projects = useProjects();
  const collisionPadding = useOverlayPadding();
  const [creating, setCreating] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const opening = useRef(false);
  // A project gone from the store stays named: Meka refuses the session's next turn and says how
  // to move it, where dropping the name here would move the session off it unasked.
  const names = projectNames(projects.data, value);
  if (!names.length && !canCreate) return null;
  return (
    <>
      <Select.Root
        value={value || NONE}
        onValueChange={(name) => {
          if (name === NEW) {
            opening.current = true;
            setCreating(true);
          } else onChange(name === NONE ? '' : name);
        }}
        disabled={disabled}
      >
        <Select.Trigger
          ref={trigger}
          className="project-trigger"
          aria-label="Project"
          aria-busy={busy || undefined}
          data-saving={busy || undefined}
          title={`Project: ${value || 'none'}${locked ? ' (available when idle)' : ''}`}
        >
          <span className="composer-select-label">
            <FolderKanban size={14} aria-hidden="true" />
            <Select.Value />
          </span>
          <Select.Icon className="composer-select-chevron">
            <ChevronDown size={14} />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            className="profile-popup"
            aria-label="Project options"
            position="popper"
            side="top"
            align="end"
            sideOffset={6}
            collisionPadding={collisionPadding}
            onCloseAutoFocus={(event) => {
              // The new project's dialog has opened by now, and focus belongs in its name field.
              if (!opening.current) return;
              opening.current = false;
              event.preventDefault();
            }}
          >
            <Select.Viewport>
              {[NONE, ...names].map((name) => (
                <Select.Item className="composer-select-option" key={name} value={name}>
                  <Select.ItemText>{name === NONE ? 'No project' : name}</Select.ItemText>
                  <Select.ItemIndicator className="composer-select-check">
                    <Check size={14} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
              {canCreate && (
                <>
                  <Select.Separator className="menu-separator" />
                  <Select.Item className="composer-select-option" value={NEW}>
                    <Plus size={14} aria-hidden="true" />
                    <Select.ItemText>New project…</Select.ItemText>
                  </Select.Item>
                </>
              )}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="New project"
        onCloseAutoFocus={(event) => {
          // The option that opened the dialog is gone, so focus returns to the picker.
          event.preventDefault();
          trigger.current?.focus();
        }}
      >
        {creating && (
          <ProjectForm
            onSaved={async (name) => {
              // The list is read again before the pick, as a new session drops a pick it lacks.
              await runtime.queries.invalidateQueries();
              setCreating(false);
              onChange(name);
            }}
          />
        )}
      </Dialog>
    </>
  );
}
