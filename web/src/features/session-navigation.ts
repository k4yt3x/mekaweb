import { createContext, useContext, type RefObject } from 'react';
import type { NewConversationState, NewSessionSetup } from './use-new-conversation';

export const SessionNavigationContext = createContext<{
  newSession: (setup?: NewSessionSetup) => void;
  mobileSessionsOpen: boolean;
  setMobileSessionsOpen: (open: boolean) => void;
  newConversation: NewConversationState;
  searchRequested: boolean;
  finishSearch: () => void;
  composerFocusRef: RefObject<string | null>;
} | null>(null);

export function useSessionNavigation() {
  const value = useContext(SessionNavigationContext);
  if (!value) throw new Error('Session navigation is unavailable.');
  return value;
}
