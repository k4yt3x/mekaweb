import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronsUpDown, Server, Settings } from 'lucide-react';
import { useConnection, useRuntime, useSettings } from '../connections/context';
import { useOverlayPadding } from './visual-viewport';

/** The active connection, at the foot of the navigation, with a menu to change it. */
export function ConnectionSwitcher({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const state = useConnection();
  const runtime = useRuntime();
  const settings = useSettings();
  const collisionPadding = useOverlayPadding();
  const current = state.connection;
  if (!current) return null;
  // A suspended connection stays listed while it is the one in use.
  const choices = settings.connections.filter((c) => !c.suspended || c.id === current.id);
  const status =
    state.connectionIssue === 'offline'
      ? 'Offline'
      : state.connectionIssue === 'checking'
        ? 'Reconnecting'
        : 'Connected';
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="connection-switcher"
          data-status={state.connectionIssue ?? 'connected'}
          aria-label={`Connection: ${current.name}, ${status.toLowerCase()}`}
          title={`${current.name} · ${status}`}
        >
          <Server size={18} aria-hidden="true" />
          <span className="connection-name">{current.name}</span>
          <ChevronsUpDown size={14} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="menu-panel connection-menu"
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={collisionPadding}
        >
          <DropdownMenu.RadioGroup
            value={current.id}
            onValueChange={(id) => {
              const record = settings.connections.find((c) => c.id === id);
              onNavigate?.();
              if (record && id !== current.id) void runtime.connect(record);
            }}
          >
            {choices.map((c) => (
              <DropdownMenu.RadioItem key={c.id} value={c.id} className="menu-item">
                <span className="connection-name">{c.name}</span>
                <DropdownMenu.ItemIndicator className="connection-option-check">
                  <Check size={14} />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item
            className="menu-item"
            onSelect={() => {
              onNavigate?.();
              location.hash = '/settings';
            }}
          >
            <Settings size={14} />
            Manage connections
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
