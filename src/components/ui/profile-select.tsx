import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { Schema } from '../../api/client';

export function ProfileSelect({
  value,
  profiles,
  disabled,
  busy,
  locked,
  onChange,
}: {
  value: string | undefined;
  profiles: Schema['ProfileView'][];
  disabled: boolean;
  busy: boolean;
  locked: boolean;
  onChange: (value: string) => void;
}) {
  const missing = value && !profiles.some((profile) => profile.name === value);
  return (
    <Select.Root value={value ?? ''} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger
        className="profile-trigger"
        aria-label="Profile"
        aria-busy={busy || undefined}
        data-saving={busy || undefined}
        title={`Profile: ${value ?? 'not reported'}${locked ? ' (available when idle)' : ''}`}
      >
        <span className="composer-select-label">
          <Select.Value placeholder="Profile" />
        </span>
        <Select.Icon className="composer-select-chevron">
          <ChevronDown size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="profile-popup"
          aria-label="Profile options"
          position="popper"
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={10}
        >
          <Select.Viewport>
            {missing && (
              <Select.Item className="composer-select-option" value={value} disabled>
                <Select.ItemText>{value}</Select.ItemText>
              </Select.Item>
            )}
            {profiles.map((profile) => (
              <Select.Item
                className="composer-select-option"
                key={profile.name}
                value={profile.name}
                title={profile.model ?? undefined}
              >
                <Select.ItemText>{profile.name}</Select.ItemText>
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
