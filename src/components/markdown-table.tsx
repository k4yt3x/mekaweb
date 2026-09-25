import { useLayoutEffect, useRef, type ComponentProps } from 'react';
import { scrollRegion } from './scrolling';
import { fitTableColumns, tableSampleRows, TABLE_MEASUREMENT_BUDGET } from './table-layout';

function inset(cell: HTMLTableCellElement) {
  const style = getComputedStyle(cell);
  return (
    parseFloat(style.paddingLeft) +
    parseFloat(style.paddingRight) +
    parseFloat(style.borderLeftWidth) +
    parseFloat(style.borderRightWidth)
  );
}

interface CellMeasure {
  width: number;
  inset: number;
  minimum: number;
}
interface MeasurementCache {
  rows: WeakMap<HTMLTableRowElement, { html: string; cells: CellMeasure[] }>;
  wrappingWidth: number;
}

function measure(table: HTMLTableElement, cache: MeasurementCache) {
  const rows = Array.from(table.rows);
  const count = rows[0]?.cells.length ?? 0;
  // GFM tables have no spans. Leave any future, more complex markup to native layout.
  if (
    !count ||
    count > 100 ||
    // Sampling must never miss an indivisible formula and let it overlap a cell.
    (rows.length * count > TABLE_MEASUREMENT_BUDGET && table.querySelector('.katex')) ||
    rows.some((row) =>
      Array.from(row.cells).some((cell) => cell.colSpan !== 1 || cell.rowSpan !== 1),
    )
  )
    return;

  const sampled = tableSampleRows(rows.length, count).map((index) => rows[index]!);
  const pending = sampled
    .map((row) => ({ row, html: row.innerHTML }))
    .filter(({ row, html }) => cache.rows.get(row)?.html !== html);
  if (pending.length) {
    const probe = document.createElement('table');
    probe.className = 'table-measure';
    probe.setAttribute('aria-hidden', 'true');
    probe.inert = true;
    const body = probe.createTBody();
    for (const { row } of pending) {
      const clone = row.cloneNode(true) as HTMLTableRowElement;
      // Do not duplicate footnote IDs, even during a synchronous measurement.
      clone.removeAttribute('id');
      clone.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
      body.append(clone);
    }
    const unit = body.insertRow().insertCell();
    // A short readable line is a floor for prose only, never a fixed column size.
    unit.textContent = '000000000000000000';
    table.parentElement!.append(probe);
    try {
      const cloned = Array.from(probe.rows).slice(0, -1);
      const measurements = cloned.map((row) =>
        Array.from(row.cells, (cell) => ({
          // Round up to keep fractional glyph widths from wrapping compact values.
          width: Math.ceil(cell.getBoundingClientRect().width),
          inset: inset(cell),
          minimum: 0,
        })),
      );
      cache.wrappingWidth = unit.getBoundingClientRect().width - inset(unit);
      // A second batched layout preserves native constraints for indivisible rich
      // content such as formulas, while ordinary prose/URLs can still wrap.
      probe.dataset.minimum = 'true';
      cloned.forEach((row, index) => {
        for (const cell of row.cells)
          measurements[index]![cell.cellIndex]!.minimum = Math.ceil(
            cell.getBoundingClientRect().width,
          );
      });
      pending.forEach(({ row, html }, index) => {
        cache.rows.set(row, { html, cells: measurements[index]! });
      });
    } finally {
      probe.remove();
    }
  }
  const columns = Array.from({ length: count }, () => ({
    cells: [] as number[],
    inset: 0,
    minimum: 0,
  }));
  for (const row of sampled) {
    cache.rows.get(row)!.cells.forEach((cell, index) => {
      const column = columns[index];
      if (!column) return;
      column.cells.push(cell.width);
      column.inset = Math.max(column.inset, cell.inset);
      column.minimum = Math.max(column.minimum, cell.minimum);
    });
  }
  return { columns, wrappingWidth: cache.wrappingWidth };
}

function observeTable(
  viewport: HTMLDivElement,
  table: HTMLTableElement,
  colgroup: HTMLTableColElement,
) {
  let disposed = false;
  let dirty = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  let lastUpdate = 0;
  let lastWidth = 0;
  let lastFont = '';
  let measured: ReturnType<typeof measure>;
  let applied = '';
  const cache: MeasurementCache = { rows: new WeakMap(), wrappingWidth: 0 };

  function dimensions() {
    const style = getComputedStyle(table);
    const font = [
      style.font,
      style.letterSpacing,
      style.fontFeatureSettings,
      style.fontVariationSettings,
    ].join('/');
    const region = getComputedStyle(table.parentElement!);
    const available =
      viewport.clientWidth -
      parseFloat(region.borderLeftWidth) -
      parseFloat(region.borderRightWidth);
    return { font, available };
  }

  function update() {
    if (disposed || !viewport.clientWidth) return;
    const { font, available } = dimensions();
    if (!dirty && font === lastFont && available === lastWidth) return;
    if (font !== lastFont) cache.rows = new WeakMap();
    if (dirty || font !== lastFont) measured = measure(table, cache);
    dirty = false;
    lastFont = font;
    lastWidth = available;
    lastUpdate = performance.now();
    if (!measured) {
      colgroup.replaceChildren();
      table.style.removeProperty('width');
      delete table.dataset.sized;
      applied = '';
      return;
    }
    const widths = fitTableColumns(measured.columns, available, measured.wrappingWidth);
    const key = widths.map((width) => width.toFixed(3)).join(',');
    if (key === applied) return;
    applied = key;
    const cols = widths.map((width) => {
      const col = document.createElement('col');
      col.style.width = `${width}px`;
      return col;
    });
    // React owns the table content; this otherwise empty colgroup owns only layout.
    colgroup.replaceChildren(...cols);
    table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
    table.dataset.sized = 'true';
  }

  function schedule(contentChanged = false, immediate = false) {
    if (disposed) return;
    dirty ||= contentChanged;
    if (immediate && timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (timer !== undefined || frame !== undefined) return;
    // Throttle, rather than debounce: a continuous stream still gets measured,
    // with one batched read/write per interval instead of one per token.
    timer = setTimeout(
      () => {
        timer = undefined;
        frame = requestAnimationFrame(() => {
          frame = undefined;
          update();
        });
      },
      immediate ? 0 : Math.max(0, 150 - (performance.now() - lastUpdate)),
    );
  }
  const resize = new ResizeObserver(() => {
    if (disposed) return;
    const { font, available } = dimensions();
    if (font !== lastFont || available !== lastWidth) schedule(false, true);
  });
  resize.observe(viewport);
  resize.observe(table);
  const mutation = new MutationObserver((records) => {
    if (records.some((record) => !colgroup.contains(record.target))) schedule(true);
  });
  mutation.observe(table, { subtree: true, childList: true, characterData: true });
  const fontsChanged = () => {
    cache.rows = new WeakMap();
    schedule(true, true);
  };
  document.fonts.addEventListener('loadingdone', fontsChanged);
  document.fonts.addEventListener('loadingerror', fontsChanged);
  update();
  return () => {
    disposed = true;
    resize.disconnect();
    mutation.disconnect();
    document.fonts.removeEventListener('loadingdone', fontsChanged);
    document.fonts.removeEventListener('loadingerror', fontsChanged);
    clearTimeout(timer);
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}

export function MarkdownTable({ children }: ComponentProps<'table'>) {
  const viewport = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const columns = useRef<HTMLTableColElement>(null);
  useLayoutEffect(() => {
    if (viewport.current && table.current && columns.current)
      return observeTable(viewport.current, table.current, columns.current);
  }, []);
  return (
    <div className="table-layout" ref={viewport}>
      <div
        className="table-scroll"
        role="group"
        aria-label="Table"
        tabIndex={0}
        onKeyDown={scrollRegion}
      >
        <table ref={table}>
          <colgroup ref={columns} />
          {children}
        </table>
      </div>
    </div>
  );
}
