import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useRuntime, useSettings } from '../connections/context';
import { Button } from './ui/button';

export function NavigationToggle({ className = '' }: { className?: string }) {
  const { storage } = useRuntime();
  const { layout } = useSettings();
  const label = layout.navigationCollapsed ? 'Show navigation' : 'Hide navigation';
  return (
    <Button
      variant="ghost"
      size="icon"
      className={`desktop-control ${className}`}
      aria-label={label}
      title={label}
      aria-expanded={!layout.navigationCollapsed}
      aria-controls="workspace-navigation"
      onClick={() => {
        storage.layout({ navigationCollapsed: !layout.navigationCollapsed });
        requestAnimationFrame(() => {
          Array.from(
            document.querySelectorAll<HTMLButtonElement>(
              `[aria-label="${layout.navigationCollapsed ? 'Hide' : 'Show'} navigation"]`,
            ),
          )
            .find((button) => button.getClientRects().length > 0)
            ?.focus();
        });
      }}
    >
      {layout.navigationCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
    </Button>
  );
}
