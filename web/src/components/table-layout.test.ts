import { describe, expect, it } from 'vitest';
import { fitTableColumns, tableSampleRows, type TableColumnMeasure } from './table-layout';

const column = (cells: number[], inset = 24): TableColumnMeasure => ({
  cells: cells.map((width) => width + inset),
  inset,
});
const sum = (widths: number[]) => widths.reduce((total, width) => total + width, 0);

describe('content-based table sizing', () => {
  it('fits short dates and gives the remaining space to descriptions', () => {
    const widths = fitTableColumns(
      [column([35, 82, 85, 85]), column([35, 850, 430, 140])],
      800,
      150,
    );
    expect(widths[0]).toBe(109);
    expect(widths[1]).toBeCloseTo(691);
  });

  it('lets a small numeric table take its natural width', () => {
    expect(fitTableColumns([column([10, 20]), column([15, 25]), column([10])], 800, 150)).toEqual([
      44, 49, 34,
    ]);
  });

  it('distributes space by demand, then redistributes when a short column is satisfied', () => {
    const widths = fitTableColumns([column([40]), column([400]), column([900])], 900, 100);
    expect(widths[0]).toBe(64);
    expect(sum(widths)).toBeCloseTo(900);
    expect((widths[2]! - 24) / (widths[1]! - 24)).toBeCloseTo(1.5);
  });

  it('limits the influence of a single long outlier without hiding it', () => {
    const ordinary = fitTableColumns(
      [column([300, 300, 300, 300]), column([300, 300, 300, 300])],
      500,
      100,
    );
    const outlier = fitTableColumns(
      [column([300, 300, 300, 30000]), column([300, 300, 300, 300])],
      500,
      100,
    );
    outlier.forEach((width, index) => expect(width).toBeCloseTo(ordinary[index]!));
    // When space is available, even the outlier can use it.
    expect(fitTableColumns([column([10, 10, 10, 200])], 500, 100)).toEqual([224]);
  });

  it('keeps many columns readable through horizontal scrolling', () => {
    const widths = fitTableColumns(
      Array.from({ length: 6 }, () => column([20, 400])),
      320,
      120,
    );
    expect(widths).toEqual(Array.from({ length: 6 }, () => 144));
    expect(sum(widths)).toBeGreaterThan(320);
  });

  it('preserves native minimum sizes for indivisible formulas', () => {
    const widths = fitTableColumns([{ ...column([500]), minimum: 400 }, column([40])], 320, 120);
    expect(widths).toEqual([400, 64]);
  });

  it('scales the same layout with the font and viewport, without fixed pixel column widths', () => {
    const measures = [column([30, 90]), column([50, 500]), column([20, 700])];
    const widths = fitTableColumns(measures, 800, 150);
    const larger = fitTableColumns(
      measures.map((c) => ({
        cells: c.cells.map((width) => width * 2),
        inset: c.inset * 2,
      })),
      1600,
      300,
    );
    larger.forEach((width, index) => expect(width).toBeCloseTo(widths[index]! * 2));
  });

  it('handles empty cells, one column, and a hidden table', () => {
    expect(fitTableColumns([column([0, 0]), column([0])], 500, 100)).toEqual([24, 24]);
    expect(fitTableColumns([column([900])], 320, 100)[0]).toBeCloseTo(320);
    expect(fitTableColumns([], 320, 100)).toEqual([]);
    expect(fitTableColumns([column([100])], 0, 100)).toEqual([]);
  });

  it('preserves width budgets and bounds across different column counts and available space', () => {
    for (let count = 1; count <= 12; count++) {
      const columns = Array.from({ length: count }, (_, i) =>
        column([17 * (i + 1), 121 * (i + 1)]),
      );
      for (const available of [250, 400, 800, 2000]) {
        const widths = fitTableColumns(columns, available, 140);
        const minimum = sum(
          columns.map((c) => Math.min(Math.max(...c.cells) - c.inset, 140) + c.inset),
        );
        const maximum = sum(columns.map((c) => Math.max(...c.cells)));
        expect(sum(widths)).toBeCloseTo(Math.max(minimum, Math.min(maximum, available)));
        widths.forEach((width, i) => {
          expect(width).toBeGreaterThanOrEqual(
            Math.min(Math.max(...columns[i]!.cells) - 24, 140) + 24,
          );
          expect(width).toBeLessThanOrEqual(Math.max(...columns[i]!.cells));
        });
      }
    }
  });
});

it('bounds row sampling and includes the header, latest row, and evenly spread history', () => {
  expect(tableSampleRows(0, 2)).toEqual([]);
  expect(tableSampleRows(1, 2)).toEqual([0]);
  expect(tableSampleRows(4, 2)).toEqual([0, 1, 2, 3]);
  const indexes = tableSampleRows(10000, 10);
  expect(indexes).toHaveLength(100);
  expect(indexes[0]).toBe(0);
  expect(indexes.at(-1)).toBe(9999);
  expect(new Set(indexes).size).toBe(indexes.length);
});
