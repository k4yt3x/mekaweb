export interface TableColumnMeasure {
  /** Unwrapped cell widths, including padding and borders. */
  cells: readonly number[];
  inset: number;
  /** Native min-content width, including inset (e.g. an indivisible formula). */
  minimum?: number;
}

export const TABLE_MEASUREMENT_BUDGET = 1000;

function demand(widths: readonly number[]) {
  const sorted = [...widths].sort((a, b) => a - b);
  // Winsorize at Tukey's upper fence: an outlier still wraps, but cannot claim
  // all the flexible space. With few samples, retain every measurement.
  const q1 = sorted[Math.floor((sorted.length - 1) / 4)] ?? 0;
  const q3 = sorted[Math.floor(((sorted.length - 1) * 3) / 4)] ?? 0;
  const ceiling = sorted.length < 4 ? Infinity : q3 + 1.5 * (q3 - q1);
  return widths.reduce((sum, width) => sum + Math.min(width, ceiling), 0) / widths.length;
}

/**
 * Bounded content fitting. Short columns stop at their unwrapped width; prose
 * gets a readable wrapping floor. Between those bounds, square-root weights
 * minimize the continuous approximation sum(demand / contentWidth) to wrapping.
 * This is a readability heuristic, not an exact minimum-height table solver.
 */
export function fitTableColumns(
  columns: readonly TableColumnMeasure[],
  available: number,
  wrappingWidth: number,
): number[] {
  if (!columns.length || !Number.isFinite(available) || available <= 0) return [];
  const bounds = columns.map(({ cells, inset, minimum = inset }) => {
    const widths = cells.map((width) => Math.max(0, width - inset));
    const max = Math.max(0, ...widths);
    return {
      min: Math.min(max, Math.max(minimum - inset, wrappingWidth)),
      max,
      inset,
      weight: Math.sqrt(Math.max(1, demand(widths) || 0)),
    };
  });
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const minimum = sum(bounds.map((column) => column.min));
  const maximum = sum(bounds.map((column) => column.max));
  const budget = Math.max(minimum, Math.min(maximum, available - sum(bounds.map((c) => c.inset))));
  if (budget >= maximum) return bounds.map((c) => c.max + c.inset);
  if (budget <= minimum) return bounds.map((c) => c.min + c.inset);

  // Water filling with lower and upper bounds; binary search avoids repeatedly
  // redistributing widths as columns reach their natural size.
  let low = 0;
  let high = Math.max(...bounds.map((c) => c.max / c.weight));
  const width = (c: (typeof bounds)[number], scale: number) =>
    Math.max(c.min, Math.min(c.max, c.weight * scale));
  for (let iteration = 0; iteration < 48; iteration++) {
    const scale = (low + high) / 2;
    if (sum(bounds.map((c) => width(c, scale))) > budget) high = scale;
    else low = scale;
  }
  return bounds.map((c) => width(c, low) + c.inset);
}

/** Bound measurement work while including the header, latest row, and rows throughout a table. */
export function tableSampleRows(rows: number, columns: number): number[] {
  if (rows <= 0 || columns <= 0) return [];
  const count = Math.min(rows, Math.max(2, Math.floor(TABLE_MEASUREMENT_BUDGET / columns)));
  return Array.from({ length: count }, (_, index) =>
    count === 1 ? 0 : Math.round((index * (rows - 1)) / (count - 1)),
  );
}
