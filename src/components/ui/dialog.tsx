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
  onOpenAutoFocus,
  className = '',
  headerActions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  placement?: 'center' | 'left' | 'right';
  onCloseAutoFocus?: Primitive.DialogContentProps['onCloseAutoFocus'];
  onOpenAutoFocus?: Primitive.DialogContentProps['onOpenAutoFocus'];
  className?: string;
  headerActions?: ReactNode;
}) {
  const close = (
    <Primitive.Close className="button button-ghost button-icon" aria-label="Close dialog">
      <X size={18} />
    </Primitive.Close>
  );
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="dialog-overlay" />
        <Primitive.Content
          className={`dialog-content ${wide ? 'dialog-wide' : ''} dialog-${placement} ${className}`}
          onCloseAutoFocus={onCloseAutoFocus}
          onOpenAutoFocus={onOpenAutoFocus}
          onInteractOutside={(event) => {
            const target = event.detail.originalEvent.target;
            // Recovery controls sit above modals; using them must not discard an editor.
            if (target instanceof Element && target.closest('.connection-banner'))
              event.preventDefault();
          }}
        >
          <div className="dialog-heading">
            <Primitive.Title>{title}</Primitive.Title>
            {headerActions ? (
              <div className="dialog-heading-actions">
                {headerActions}
                {close}
              </div>
            ) : (
              close
            )}
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
