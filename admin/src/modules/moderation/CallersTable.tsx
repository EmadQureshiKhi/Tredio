"use client";
import { ListFilter, PenLine } from "lucide-react";
import { Badge } from "@/src/components/ui/Badge";
import { Button } from "@/src/components/ui/Button";
import { formatAge, formatDate, formatNumber, shortAddress } from "@/src/lib/format";
import { type Column, Line, SortableTable } from "@/src/modules/system/Table";
import type { SocialCaller } from "@/src/types/admin";

function Who({ c }: { c: SocialCaller }) {
  return (
    <div className="min-w-0">
      <p className={`truncate ${c.handle ? "font-medium text-fg" : "text-subtle"}`}>{c.handle ? `@${c.handle}` : "No handle"}</p>
      <p className="truncate font-mono text-[11px] text-subtle" title={c.address}>
        {shortAddress(c.address)}
      </p>
    </div>
  );
}

const Linked = ({ c }: { c: SocialCaller }) =>
  c.linkedAccount ? (
    <span className="block truncate font-mono text-[12px] text-fg" title={c.linkedAccount}>
      {shortAddress(c.linkedAccount)}
    </span>
  ) : (
    <span className="text-subtle">Not linked</span>
  );

const Hidden = ({ n }: { n: number }) => (n > 0 ? <Badge tone="warn">{formatNumber(n)}</Badge> : <span className="text-subtle">0</span>);

/** Callers with what they published; "Content" filters the posts and calls to one of them. */
export function CallersTable({ rows, now, onContent, onEdit }: { rows: SocialCaller[]; now: number; onContent: (c: SocialCaller) => void; onEdit: (c: SocialCaller) => void }) {
  // In the table the buttons center on the caller's first line; on a phone they sit below the card's lines.
  const actions = (c: SocialCaller, className = "") => (
    <div className={`flex justify-end gap-1.5 ${className}`}>
      <Button size="sm" variant="ghost" icon={<ListFilter size={14} aria-hidden />} onClick={() => onContent(c)} aria-label={`Show content by ${c.handle ? `@${c.handle}` : shortAddress(c.address)}`}>
        Content
      </Button>
      <Button size="sm" icon={<PenLine size={14} aria-hidden />} onClick={() => onEdit(c)} aria-label={`Edit ${c.handle ? `@${c.handle}` : shortAddress(c.address)}`}>
        Edit
      </Button>
    </div>
  );
  const columns: Column<SocialCaller>[] = [
    { key: "caller", label: "Caller", render: (c) => <Who c={c} />, sort: (c) => c.handle ?? `~${c.address}` },
    // Below `lg` the table keeps the counts and actions; the phone card shows everything.
    { key: "linked", label: "Trades as", className: "hidden w-40 lg:table-cell", render: (c) => <Linked c={c} />, sort: (c) => c.linkedAccount },
    { key: "calls", label: "Calls", align: "right", className: "w-20", render: (c) => formatNumber(c.calls), sort: (c) => c.calls },
    { key: "posts", label: "Posts", align: "right", className: "w-20", render: (c) => formatNumber(c.posts), sort: (c) => c.posts },
    { key: "hidden", label: "Hidden", align: "right", className: "w-20", render: (c) => <Hidden n={c.hidden} />, sort: (c) => c.hidden },
    {
      key: "joined",
      label: "Joined",
      align: "right",
      className: "hidden w-24 lg:table-cell",
      render: (c) => (
        <span className="text-muted" title={formatDate(Date.parse(c.createdAt))}>
          {formatAge(Date.parse(c.createdAt), now)}
        </span>
      ),
      sort: (c) => Date.parse(c.createdAt),
    },
    { key: "actions", label: "", align: "right", className: "w-52", render: (c) => actions(c, "-my-1.5") },
  ];
  return (
    <SortableTable
      label="Callers"
      testId="callers-table"
      rowTestId="caller-row"
      columns={columns}
      rows={rows}
      rowKey={(c) => c.address}
      mobile={(c) => (
        <div className="space-y-2">
          <Who c={c} />
          <div>
            <Line label="Trades as">
              <Linked c={c} />
            </Line>
            <Line label="Calls and posts">
              {formatNumber(c.calls)} and {formatNumber(c.posts)}
            </Line>
            <Line label="Hidden">
              <Hidden n={c.hidden} />
            </Line>
            <Line label="Joined">{formatAge(Date.parse(c.createdAt), now)}</Line>
          </div>
          {actions(c)}
        </div>
      )}
    />
  );
}
