import * as Popover from '@radix-ui/react-popover';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown, Folder, FolderPlus, Server } from 'lucide-react';
import type { Schema } from '../api/client';
import { useCan, useResource, useRuntime } from '../connections/context';
import { useAction } from '../components/actions';
import { ErrorNotice } from '../components/common';
import type { Gateway } from '../api/gateway';
import { Button } from '../components/ui/button';
import { useMediaQuery } from '../components/media-query';
import { useOverlayPadding } from '../components/visual-viewport';
import { directoryLabel, recentDirectories, sameDirectory } from './working-directory';

export function WorkingDirectoryPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const canRead = useCan('sessions:r');
  const [open, setOpen] = useState(false);
  const inputId = useId();
  const recentId = useId();
  const content = useRef<HTMLDivElement>(null);
  const collisionPadding = useOverlayPadding();
  const coarse = useMediaQuery('(pointer: coarse)');
  // Fetched once for suggestions; session creation invalidates it, so it needs no polling.
  const sessions = useResource<Schema['ListSessionsResponse']>(
    '/v1/sessions',
    { limit: 50 },
    canRead,
    0,
  );
  const recent = recentDirectories(sessions.data?.sessions ?? []);
  const current = value.trim();
  const runtime = useRuntime();
  const making = useAction();
  const [made, setMade] = useState('');
  // meka refuses a working folder that is not there; mekaweb can make it, and any above it.
  const makeable = current.startsWith('/') || current.startsWith('~/');
  function choose(path: string) {
    onChange(path);
    setOpen(false);
  }
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(
      content.current?.querySelectorAll<HTMLElement>('input, .directory-option') ?? [],
    );
    const index = items.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    items[
      Math.min(items.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))
    ]?.focus();
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="directory-trigger"
          disabled={disabled}
          aria-label={`Working directory: ${current || 'server default'}`}
          title={current || 'Server default working directory'}
        >
          <Folder size={15} aria-hidden="true" />
          <span className="directory-trigger-label">
            {current ? directoryLabel(current).name : 'Default directory'}
          </span>
          <ChevronDown size={14} aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={content}
          className="directory-picker"
          aria-label="Working directory"
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={collisionPadding}
          onKeyDown={navigate}
          onOpenAutoFocus={(event) => {
            // Keep the on-screen keyboard closed until the path field is chosen.
            if (coarse) event.preventDefault();
          }}
        >
          <form
            className="directory-form"
            onSubmit={(event) => {
              event.preventDefault();
              setOpen(false);
            }}
          >
            <label htmlFor={inputId}>Working directory</label>
            <input
              id={inputId}
              value={value}
              placeholder="Absolute server path"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => {
                setMade('');
                making.reset();
                onChange(event.target.value);
              }}
            />
          </form>
          {makeable && (
            <div className="directory-make">
              <Button
                variant="ghost"
                size="sm"
                disabled={making.busy}
                onClick={() =>
                  void making.run(async () => {
                    const result = await runtime.gateway.send<Gateway['Made']>(
                      'POST',
                      '/api/files/folders',
                      { path: current, parents: true },
                    );
                    onChange(result.path);
                    setMade(result.path);
                  })
                }
              >
                <FolderPlus size={14} aria-hidden="true" />
                {made === current ? 'Folder is there' : 'Make this folder'}
              </Button>
              <ErrorNotice error={making.error} />
            </div>
          )}
          <DirectoryOption
            icon={<Server size={15} aria-hidden="true" />}
            name="Server default"
            detail="meka’s current directory"
            selected={!current}
            onSelect={() => choose('')}
          />
          {recent.length > 0 && (
            <div role="group" aria-labelledby={recentId}>
              <div className="directory-section" id={recentId}>
                Recent
              </div>
              {recent.map((path) => {
                const { name, parent } = directoryLabel(path);
                return (
                  <DirectoryOption
                    key={path}
                    icon={<Folder size={15} aria-hidden="true" />}
                    name={name}
                    detail={parent}
                    label={path}
                    selected={sameDirectory(current, path)}
                    onSelect={() => choose(path)}
                  />
                );
              })}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function DirectoryOption({
  icon,
  name,
  detail,
  label,
  selected,
  onSelect,
}: {
  icon: ReactNode;
  name: string;
  detail: string;
  label?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="directory-option"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      onClick={onSelect}
    >
      {icon}
      <span className="directory-option-text">
        <span>{name}</span>
        {detail && <small>{detail}</small>}
      </span>
      {selected && <Check className="directory-option-check" size={14} aria-hidden="true" />}
    </button>
  );
}
