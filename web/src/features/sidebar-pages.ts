import { BookOpen, CalendarClock, FolderKanban, Sparkles, type LucideIcon } from 'lucide-react';

/** The pages the sidebar leads to above the sessions: what the agent works with. */
export type SidebarPage = 'projects' | 'memory' | 'skills' | 'schedules';

export const SIDEBAR_PAGES: readonly {
  id: SidebarPage;
  name: string;
  path: `/${string}`;
  icon: LucideIcon;
  /** The scope reading it takes, where one does. */
  scope?: string;
}[] = [
  { id: 'projects', name: 'Projects', path: '/projects', icon: FolderKanban },
  { id: 'memory', name: 'Memories', path: '/memory', icon: BookOpen, scope: 'memory:r' },
  { id: 'skills', name: 'Skills', path: '/skills', icon: Sparkles },
  {
    id: 'schedules',
    name: 'Schedules',
    path: '/schedules',
    icon: CalendarClock,
    scope: 'schedule:r',
  },
];

/** The page the address `pathname` leads to, if it is one of them. */
export function sidebarPage(pathname: string): SidebarPage | undefined {
  return SIDEBAR_PAGES.find((page) => page.path === pathname)?.id;
}
