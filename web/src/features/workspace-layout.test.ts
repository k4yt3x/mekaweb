import { describe, expect, it } from 'vitest';
import {
  MAIN_MIN,
  RAIL_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  WIDE_WIDTH,
  panelMakesWay,
  workspaceLayout,
} from './workspace-layout';

const widths = { list: 236, panel: 400, conversation: 480 };
const layout = (width: number, shown: { panel: boolean; wide: boolean }, collapsed = false) =>
  workspaceLayout({ width, collapsed, preferred: widths, desired: widths, shown });

describe('workspace layout', () => {
  it('gives the conversation the rest beside the list and the rail', () => {
    const columns = layout(1200, { panel: false, wide: false });
    expect(columns.listCollapsed).toBe(false);
    expect(columns.columns).toBe('var(--sessions-width) minmax(0, 1fr) var(--rail-width)');
  });

  it('keeps the list beside a panel where they fit, and collapses it where they do not', () => {
    const fits = RAIL_WIDTH + 236 + MAIN_MIN + 400;
    expect(layout(fits, { panel: true, wide: false }).listCollapsed).toBe(false);
    const narrow = layout(fits - 1, { panel: true, wide: false });
    expect(narrow.listCollapsed).toBe(true);
    expect(narrow.columns).toBe(
      'var(--sidebar-rail-width) minmax(0, 1fr) var(--panel-width) var(--rail-width)',
    );
    expect(narrow.panel.width).toBe(400);
  });

  it('sets the conversation beside the editor, which takes the rest', () => {
    const columns = layout(1300, { panel: false, wide: true });
    expect(columns.listCollapsed).toBe(false);
    expect(columns.columns).toBe(
      'var(--sessions-width) var(--conversation-width) minmax(0, 1fr) var(--rail-width)',
    );
    expect(columns.conversation).toEqual({
      width: 480,
      max: 1300 - RAIL_WIDTH - 236 - WIDE_WIDTH.min,
    });
  });

  it('collapses the list before narrowing the editor below what it is given', () => {
    const fits = RAIL_WIDTH + 236 + 480 + WIDE_WIDTH.wanted;
    expect(layout(fits, { panel: false, wide: true }).listCollapsed).toBe(false);
    expect(layout(fits - 1, { panel: false, wide: true }).listCollapsed).toBe(true);
  });

  it('narrows the conversation, not below its least, to leave the editor its least', () => {
    const columns = layout(1000, { panel: false, wide: true }, true);
    expect(columns.conversation.width).toBe(480);
    const tight = layout(RAIL_WIDTH + SIDEBAR_RAIL_WIDTH + MAIN_MIN + WIDE_WIDTH.min + 20, {
      panel: false,
      wide: true,
    });
    expect(tight.conversation.width).toBe(MAIN_MIN + 20);
    const tiny = layout(600, { panel: false, wide: true });
    expect(tiny.conversation.width).toBe(MAIN_MIN);
  });

  it('narrows the panel to its least before the conversation', () => {
    const columns = layout(RAIL_WIDTH + SIDEBAR_RAIL_WIDTH + MAIN_MIN + 300, {
      panel: true,
      wide: false,
    });
    expect(columns.panel.width).toBe(300);
    expect(columns.panel.max).toBe(300);
  });

  it('honours a list collapsed by hand', () => {
    expect(layout(2000, { panel: false, wide: false }, true).listCollapsed).toBe(true);
  });
});

describe('room for the list', () => {
  it('closes the panel only where the list does not fit beside it', () => {
    expect(panelMakesWay(2000, widths, { panel: true, wide: false })).toBe(false);
    expect(panelMakesWay(900, widths, { panel: true, wide: false })).toBe(true);
    expect(panelMakesWay(900, widths, { panel: false, wide: true })).toBe(false);
  });
});
