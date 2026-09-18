import * as Primitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
// shadcn/ui's Radix composition preserves focus trapping and keyboard dismissal.
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
  placement = 'center',
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  placement?: 'center' | 'left' | 'right';
  onCloseAutoFocus?: Primitive.DialogContentProps['onCloseAutoFocus'];
}) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="dialog-overlay" />
        <Primitive.Content
          className={`dialog-content ${wide ? 'dialog-wide' : ''} dialog-${placement}`}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <div className="dialog-heading">
            <Primitive.Title>{title}</Primitive.Title>
            <Primitive.Close className="button button-ghost button-icon" aria-label="Close dialog">
              <X size={18} />
            </Primitive.Close>
          </div>
          <Primitive.Description className={description ? 'muted' : 'sr-only'}>
            {description ?? title}
          </Primitive.Description>
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
