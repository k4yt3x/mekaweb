import * as Select from '@radix-ui/react-select';
import { useEffect } from 'react';
import { Check, ChevronDown, FolderKanban } from 'lucide-react';
import { Button } from '../components/ui/button';
import { useOverlayPadding } from '../components/visual-viewport';
import { projectNames, useProjects } from './projects-query';

// Radix takes no empty value, and no project name starts with a hyphen.
const NONE = '-';

/** The project a new session opens on. */
export function ProjectPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const projects = useProjects();
  const names = projectNames(projects.data, value);
  const collisionPadding = useOverlayPadding();
  // The pick outlives the session it opened, so one renamed or removed since then is dropped.
  const gone = Boolean(
    value && projects.data && !projects.data.projects.some((project) => project.name === value),
  );
  useEffect(() => {
    if (gone) onChange('');
  }, [gone, onChange]);
  return (
    <Select.Root
      value={value || NONE}
      onValueChange={(name) => onChange(name === NONE ? '' : name)}
      disabled={disabled}
    >
      <Select.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="directory-trigger"
          aria-label={`Project: ${value || 'none'}`}
          title={value ? `Project: ${value}` : 'No project'}
        >
          <FolderKanban size={15} aria-hidden="true" />
          <span className="directory-trigger-label">
            <Select.Value />
          </span>
          <ChevronDown size={14} aria-hidden="true" />
        </Button>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="profile-popup"
          aria-label="Project options"
          position="popper"
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={collisionPadding}
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
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
