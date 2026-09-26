import * as Select from '@radix-ui/react-select';
import { useOverlayPadding } from '../visual-viewport';
import {
  Check,
  ChevronDown,
  CircleSlash,
  Eye,
  FolderLock,
  Shield,
  TriangleAlert,
} from 'lucide-react';

function PermissionIcon({ value }: { value: string | undefined }) {
  const Icon =
    value === 'none'
      ? CircleSlash
      : value === 'read'
        ? Eye
        : value === 'workspace'
          ? FolderLock
          : value === 'unrestricted'
            ? TriangleAlert
            : Shield;
  return (
    <Icon
      size={14}
      className={value === 'unrestricted' ? 'permission-warning' : undefined}
      aria-hidden="true"
    />
  );
}

export function PermissionSelect({
  value,
  options,
  disabled,
  busy = false,
  onChange,
}: {
  value: string | undefined;
  options: string[];
  disabled: boolean;
  busy?: boolean;
  onChange: (value: string) => void;
}) {
  const values = value && !options.includes(value) ? [value, ...options] : options;
  const collisionPadding = useOverlayPadding();
  return (
    <Select.Root value={value ?? ''} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger
        className="permission-trigger"
        aria-label="Permission mode"
        aria-busy={busy || undefined}
        data-saving={busy || undefined}
        title={`Permission mode: ${value ?? 'not reported'} (Shift+Tab in message input)`}
      >
        <span className="composer-select-label">
          <PermissionIcon value={value} />
          <Select.Value placeholder="Not reported" />
        </span>
        <Select.Icon className="composer-select-chevron">
          <ChevronDown size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="permission-popup"
          aria-label="Permission mode options"
          position="popper"
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={collisionPadding}
        >
          <Select.Viewport>
            {values.map((option) => (
              <Select.Item
                className="composer-select-option"
                key={option}
                value={option}
                disabled={!options.includes(option)}
              >
                <span className="composer-select-label">
                  <PermissionIcon value={option} />
                  <Select.ItemText>{option}</Select.ItemText>
                </span>
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
