import { CONVERSATION_COLUMN, PANEL_WIDTH, type Panel } from '../connections/storage';

export const PANEL_TITLES: Record<Panel, string> = {
  files: 'Files',
  context: 'Context',
  tasks: 'Tasks',
  schedules: 'Schedules',
};

/** The narrowest the conversation gets beside what is open. */
export const MAIN_MIN = CONVERSATION_COLUMN.min;
export const LIST_WIDTH = { default: 236, min: 180, max: 480 } as const;
/** The column of the panels' buttons, at the right. */
export const RAIL_WIDTH = 44;
/**
 * The editor beside the conversation: the narrowest it gets, and the width it is given before the
 * session list is.
 */
export const WIDE_WIDTH = { min: 360, wanted: 480 } as const;

export type WorkspaceSide = 'sessions' | 'panel' | 'conversation';

/** The widths asked for: saved, or being dragged. */
export interface WorkspaceWidths {
  list: number;
  panel: number;
  conversation: number;
}

/** What shows: the side panel, and the editor, which takes the conversation's side. */
export interface WorkspaceShown {
  panel: boolean;
  wide: boolean;
}

/** Whether the session list fits beside what is shown, at the widths asked for. */
export function fitsList(width: number, widths: WorkspaceWidths, shown: WorkspaceShown) {
  return (
    width >=
    RAIL_WIDTH +
      widths.list +
      (shown.wide ? widths.conversation + WIDE_WIDTH.wanted : MAIN_MIN) +
      (shown.panel ? widths.panel : 0)
  );
}

/**
 * Whether the side panel makes way for the session list to show at `width`. The editor stays,
 * holding its tabs, and the list narrows what is beside it where that is not enough.
 */
export function panelMakesWay(width: number, widths: WorkspaceWidths, shown: WorkspaceShown) {
  return shown.panel && !fitsList(width, widths, shown);
}

/**
 * The workspace's columns at `width`: the session list, unless collapsed, as asked or for want of
 * room; the conversation; the editor; the side panel; and the panels' buttons. The list gives way
 * first, then the panel, down to its narrowest, then the conversation beside the editor.
 */
export function workspaceLayout({
  width,
  collapsed,
  shownByHand = false,
  preferred,
  desired,
  shown,
}: {
  width: number;
  /** Whether the list was collapsed by hand. */
  collapsed: boolean;
  /** Whether it was shown by hand where it does not fit, to narrow what is beside it. */
  shownByHand?: boolean;
  /** The saved widths, which decide whether the list fits. */
  preferred: WorkspaceWidths;
  /** The widths asked for now, while one is dragged. */
  desired: WorkspaceWidths;
  shown: WorkspaceShown;
}) {
  const listCollapsed =
    collapsed ||
    (!shownByHand && (shown.panel || shown.wide) && !fitsList(width, preferred, shown));
  // The least the conversation, and the editor beside it, take.
  const main = shown.wide ? MAIN_MIN + WIDE_WIDTH.min : MAIN_MIN;
  const list = Math.min(
    desired.list,
    Math.max(LIST_WIDTH.min, width - RAIL_WIDTH - main - (shown.panel ? desired.panel : 0)),
  );
  const room = width - RAIL_WIDTH - (listCollapsed ? 0 : list);
  const panel = Math.min(
    desired.panel,
    Math.max(PANEL_WIDTH.min, Math.min(PANEL_WIDTH.max, room - main)),
  );
  const panelSpace = shown.panel ? panel : 0;
  const conversationMax = Math.max(MAIN_MIN, room - panelSpace - WIDE_WIDTH.min);
  const conversation = Math.min(Math.max(MAIN_MIN, desired.conversation), conversationMax);
  const beside = shown.wide ? conversation + WIDE_WIDTH.min : MAIN_MIN;
  return {
    listCollapsed,
    list: {
      width: list,
      max: Math.max(
        LIST_WIDTH.min,
        Math.min(LIST_WIDTH.max, width - RAIL_WIDTH - beside - panelSpace),
      ),
    },
    panel: {
      width: panel,
      max: Math.max(PANEL_WIDTH.min, Math.min(PANEL_WIDTH.max, room - beside)),
    },
    conversation: { width: conversation, max: conversationMax },
    columns: [
      listCollapsed ? undefined : 'var(--sessions-width)',
      shown.wide ? 'var(--conversation-width)' : 'minmax(0, 1fr)',
      shown.wide ? 'minmax(0, 1fr)' : undefined,
      shown.panel ? 'var(--panel-width)' : undefined,
      'var(--rail-width)',
    ]
      .filter(Boolean)
      .join(' '),
  };
}
