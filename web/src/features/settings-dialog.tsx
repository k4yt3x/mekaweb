import { Suspense, useEffect, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  Bell,
  BrainCircuit,
  Info,
  Keyboard,
  Palette,
  Plug,
  ScrollText,
  Settings,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { Dialog } from '../components/ui/dialog';
import { Loading } from '../components/common';
import { KeyboardShortcuts } from '../components/shortcuts';
import { useOpenSettings, type SettingsSection } from '../components/settings-control';
import { McpPage, ProvidersPage } from './pages';
import {
  AboutSettings,
  AccountSection,
  AppearanceSettings,
  GeneralSettings,
  InstructionsSettings,
  NotificationsSection,
} from './settings';
import { useConnection } from '../connections/context';

/**
 * The sections: mekaweb's own first, then how meka is set up, the keys, and what is running. The
 * standing instructions are read with `sessions:r`, as meka asks.
 */
const SECTIONS: { id: SettingsSection; name: string; icon: LucideIcon; scope?: string }[] = [
  { id: 'general', name: 'General', icon: Settings },
  { id: 'account', name: 'Account', icon: UserRound },
  { id: 'appearance', name: 'Appearance', icon: Palette },
  { id: 'notifications', name: 'Notifications', icon: Bell },
  { id: 'providers', name: 'Providers', icon: BrainCircuit },
  { id: 'mcp', name: 'MCP', icon: Plug },
  { id: 'instructions', name: 'Instructions', icon: ScrollText, scope: 'sessions:r' },
  { id: 'shortcuts', name: 'Keyboard shortcuts', icon: Keyboard },
  { id: 'about', name: 'About', icon: Info },
];

/** What is typed in, where Escape leaves Settings open so what is typed is not lost. */
const TYPED_IN = [
  'textarea',
  `input:not(${['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color']
    .map((type) => `[type="${type}"]`)
    .join(', ')})`,
  '[contenteditable]:not([contenteditable="false"])',
].join(', ');

function content(section: SettingsSection): ReactNode {
  switch (section) {
    case 'general':
      return <GeneralSettings />;
    case 'account':
      return <AccountSection />;
    case 'appearance':
      return <AppearanceSettings />;
    case 'notifications':
      return <NotificationsSection />;
    case 'providers':
      return <ProvidersPage />;
    case 'mcp':
      return <McpPage />;
    case 'instructions':
      return <InstructionsSettings />;
    case 'shortcuts':
      return <KeyboardShortcuts />;
    case 'about':
      return <AboutSettings />;
  }
}

/**
 * Settings, over whatever is shown, so changing one never leaves the session: mekaweb's own, the
 * account, meka's providers, MCP servers and instructions, the keyboard's shortcuts, and what is
 * running. Escape in a field it is typed in leaves Settings open, so what is typed is not lost.
 */
export function SettingsDialog({
  section,
  onSection,
  onClose,
}: {
  /** The section shown; none while Settings is closed. */
  section: SettingsSection | undefined;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
}) {
  const { info } = useConnection();
  const sections = SECTIONS.filter((each) => !each.scope || info?.scopes.includes(each.scope));
  const shown = sections.find((each) => each.id === section) ?? sections[0]!;
  return (
    <Dialog
      open={section !== undefined}
      onOpenChange={(open) => !open && onClose()}
      title="Settings"
      className="settings-dialog"
      onEscapeKeyDown={(event) => {
        const target = event.target;
        if (target instanceof Element && target.closest(TYPED_IN)) event.preventDefault();
      }}
    >
      <div className="settings-layout">
        <nav className="settings-sections" aria-label="Settings sections">
          {sections.map((each) => (
            <button
              key={each.id}
              type="button"
              aria-current={each.id === shown.id ? 'page' : undefined}
              onClick={() => onSection(each.id)}
            >
              <each.icon size={17} aria-hidden="true" />
              {each.name}
            </button>
          ))}
        </nav>
        <div className="settings-section" key={shown.id} data-section={shown.id}>
          <Suspense fallback={<Loading />}>{content(shown.id)}</Suspense>
        </div>
      </div>
    </Dialog>
  );
}

/** A page's old address: Settings opens at its section, over the sessions. */
export function SettingsRoute({ section }: { section: SettingsSection }) {
  const open = useOpenSettings();
  const navigate = useNavigate();
  useEffect(() => {
    open(section);
    void navigate({ to: '/sessions', replace: true });
  }, [open, navigate, section]);
  return null;
}
