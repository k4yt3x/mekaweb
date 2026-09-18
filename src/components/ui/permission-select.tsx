import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown, Shield } from 'lucide-react';

export function PermissionSelect({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string | undefined;
  options: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const values = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <Select.Root value={value ?? ''} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger
        className="permission-trigger"
        aria-label="Permission mode"
        title={`Permission mode: ${value ?? 'not reported'}`}
      >
        <Shield size={14} aria-hidden="true" />
        <Select.Value placeholder="Not reported" />
        <Select.Icon>
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
          collisionPadding={10}
        >
          <Select.Viewport>
            {values.map((option) => (
              <Select.Item
                className="permission-option"
                key={option}
                value={option}
                disabled={!options.includes(option)}
              >
                <Select.ItemText>{option}</Select.ItemText>
                <Select.ItemIndicator>
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
