import type { ComponentProps } from 'react';
import { Check } from 'lucide-react';

export function Checkbox({ className = '', ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <span className={`checkbox ${className}`}>
      <input {...props} className="checkbox-input" type="checkbox" />
      <span className="checkbox-control" aria-hidden="true">
        <Check strokeWidth={2.5} />
      </span>
    </span>
  );
}
