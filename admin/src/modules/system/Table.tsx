"use client";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { type ReactNode, useState } from "react";

/**
 * A sortable table from `md` up and a stacked list below it, from one column definition. Headers
 * with a `sort` sort on click (again to reverse); `aria-sort` says how the table is sorted.
 */

export interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  /** A sort key; columns without one do not sort. Nulls sort last either way. */
  sort?: (row: T) => number | string | null;
  align?: "left" | "right";
  /** Width or other classes for the header and cells (e.g. "w-28"). */
  className?: string;
}

type SortState = { key: string; dir: "asc" | "desc" } | null;

export function SortableTable<T>({
  columns,
  rows,
  rowKey,
  mobile,
  initialSort = null,
  label,
  testId,
  rowTestId,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** One row as a card on phones. */
  mobile: (row: T) => ReactNode;
  initialSort?: SortState;
  label: string;
  testId?: string;
  rowTestId?: string;
  empty?: ReactNode;
}) {
  const [sort, setSort] = useState<SortState>(initialSort);
  const column = sort ? columns.find((c) => c.key === sort.key) : undefined;
  const sorted = column?.sort
    ? [...rows].sort((a, b) => {
        const x = column.sort!(a);
        const y = column.sort!(b);
        if (x === null && y === null) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        return sort!.dir === "asc" ? order : -order;
      })
    : rows;

  const toggle = (key: string) => setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  if (rows.length === 0) {
    return <p className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">{empty ?? "Nothing to show."}</p>;
  }

  return (
    <div data-testid={testId} className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
      <table className="hidden w-full table-fixed border-collapse text-[13px] md:table" aria-label={label}>
        <thead>
          <tr className="border-b border-line">
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const Icon = !active ? ArrowUpDown : sort!.dir === "asc" ? ArrowUp : ArrowDown;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                  className={`px-3 py-2.5 text-xs font-medium text-subtle first:pl-5 last:pr-5 ${c.align === "right" ? "text-right" : "text-left"} ${c.className ?? ""}`}
                >
                  {c.sort ? (
                    <button
                      type="button"
                      onClick={() => toggle(c.key)}
                      className={`-mx-1 inline-flex items-center gap-1 whitespace-nowrap rounded px-1 transition-colors hover:text-fg ${active ? "text-fg" : ""} ${c.align === "right" ? "flex-row-reverse" : ""}`}
                    >
                      {c.label}
                      <Icon size={12} aria-hidden className={active ? "" : "opacity-50"} />
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {sorted.map((row) => (
            <tr key={rowKey(row)} data-testid={rowTestId} data-key={rowKey(row)} className="align-top">
              {columns.map((c) => (
                <td key={c.key} className={`min-w-0 px-3 py-3 first:pl-5 last:pr-5 ${c.align === "right" ? "text-right tabular-nums" : ""} ${c.className ?? ""}`}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-line md:hidden" aria-label={label}>
        {sorted.map((row) => (
          <li key={rowKey(row)} className="px-4 py-3 text-[13px]">
            {mobile(row)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A label and value on one line of a phone card. */
export function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-0.5">
      <span className="shrink-0 text-subtle">{label}</span>
      <span className="min-w-0 text-right tabular-nums text-fg [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}
