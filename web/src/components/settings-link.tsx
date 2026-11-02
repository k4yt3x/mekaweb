import type { ReactNode } from 'react';
import { useOpenSettings, type SettingsSection } from './settings-control';

/** The page each section had, which a link opened in a new tab still leads to. */
const ADDRESSES: Record<SettingsSection, string> = {
  general: '/settings',
  account: '/settings',
  appearance: '/settings',
  notifications: '/settings',
  providers: '/providers',
  mcp: '/mcp',
  instructions: '/settings',
  shortcuts: '/settings',
  about: '/settings',
};

/** A link to a section of Settings, which opens over what is shown rather than leaving it. */
export function SettingsLink({
  section,
  children,
}: {
  section: SettingsSection;
  children: ReactNode;
}) {
  const open = useOpenSettings();
  return (
    <a
      href={`#${ADDRESSES[section]}`}
      onClick={(event) => {
        event.preventDefault();
        open(section);
      }}
    >
      {children}
    </a>
  );
}
