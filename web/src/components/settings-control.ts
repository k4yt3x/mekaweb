import { createContext, useContext } from 'react';

/**
 * The sections of Settings: how Meka Studio behaves and looks, the account, how Meka is set up, the
 * keyboard's shortcuts, and what is running.
 */
export type SettingsSection =
  | 'general'
  | 'account'
  | 'appearance'
  | 'notifications'
  | 'providers'
  | 'mcp'
  | 'instructions'
  | 'shortcuts'
  | 'about';

/** Opens Settings over whatever is shown, at `section`, General unless given. */
export type OpenSettings = (section?: SettingsSection) => void;

export const SettingsControl = createContext<OpenSettings>(() => {});

/** Opens Settings: see {@link OpenSettings}. */
export function useOpenSettings() {
  return useContext(SettingsControl);
}
