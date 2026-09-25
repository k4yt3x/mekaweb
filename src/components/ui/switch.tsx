import { useId, type ComponentProps, type ReactNode } from 'react';

type SwitchProps = Omit<
  ComponentProps<'button'>,
  'children' | 'onClick' | 'type' | 'role' | 'aria-checked'
> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

export function Switch({ checked, onCheckedChange, className = '', ...props }: SwitchProps) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      className={`switch ${className}`}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  );
}

export function SwitchField({ label, id, ...props }: SwitchProps & { label: ReactNode }) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  return (
    <label className="switch-field" htmlFor={controlId}>
      <Switch {...props} id={controlId} />
      <span>{label}</span>
    </label>
  );
}
