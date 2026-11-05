import { ExternalLink, Sparkles } from "lucide-react";
import { Badge, type Tone } from "@/src/components/ui/Badge";
import { formatNumber, safeHttpUrl, shortAddress, wikipediaUrl } from "@/src/lib/format";
import type { Candidate, CandidateAi, CandidateStatus } from "@/src/types/admin";

const STATUS: Record<CandidateStatus, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "warn" },
  approved: { label: "Approved", tone: "ok" },
  rejected: { label: "Rejected", tone: "bad" },
  live: { label: "Live", tone: "accent" },
  retired: { label: "Retired", tone: "neutral" },
};

export function StatusBadge({ status }: { status: CandidateStatus }) {
  const s = STATUS[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Flags that rule a market out (BLOCKING_FLAGS in backend/src/ai/assess.ts); the rest ask for review. */
const BLOCKING_FLAGS = new Set(["private_individual", "minors", "sexual", "hate", "self_harm", "spam_or_scam"]);

export const flagLabel = (flag: string) => flag.replace(/_/g, " ");

export function Confidence({ value }: { value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const color = pct >= 80 ? "bg-ok" : pct >= 50 ? "bg-warn" : "bg-bad";
  return (
    <div className="flex items-center gap-2" title="AI confidence">
      <span className="sr-only">AI confidence</span>
      <span aria-hidden className="h-1.5 w-12 overflow-hidden rounded-full bg-raised ring-1 ring-line ring-inset">
        <span className={`block h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="w-9 text-right text-[13px] font-medium tabular-nums text-fg">{pct}%</span>
    </div>
  );
}

export function AiVerdict({ ai }: { ai: CandidateAi }) {
  const flags = ai.policyFlags ?? [];
  const notes = flags.length > 0 || ai.trendWorthy === false || Boolean(ai.duplicateOf);
  if (!ai.reason && !notes) return null;
  return (
    <div className="flex gap-2.5 rounded-lg border border-line bg-raised px-3 py-2.5">
      <Sparkles size={14} className="mt-[3px] shrink-0 text-accent" aria-hidden />
      <span className="sr-only">AI review</span>
      <div className="min-w-0 flex-1 text-[13px] leading-5">
        {ai.reason && <p className="break-words text-fg">{ai.reason}</p>}
        {notes && (
          <div className={`flex flex-wrap gap-1.5 ${ai.reason ? "mt-1.5" : ""}`}>
            {flags.map((f) => (
              <Badge key={f} tone={BLOCKING_FLAGS.has(f) ? "bad" : "warn"} title={BLOCKING_FLAGS.has(f) ? "Blocking policy flag" : "Policy flag: needs review"}>
                {flagLabel(f)}
              </Badge>
            ))}
            {ai.trendWorthy === false && <Badge tone="warn">not trend-worthy</Badge>}
            {ai.duplicateOf && (
              <Badge tone="neutral" title={`Same story as ${ai.duplicateOf}`}>
                duplicate of <span className="font-mono">{ai.duplicateOf}</span>
              </Badge>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ExternalAnchor({ href, children, title }: { href: string; children: React.ReactNode; title?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded text-accent underline-offset-2 hover:underline"
    >
      <span className="truncate">{children}</span>
      <ExternalLink size={12} className="shrink-0" aria-hidden />
    </a>
  );
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

/** Where the candidate came from: the pasted link, or the radar signal that surfaced it. */
export function SourceDetail({ candidate }: { candidate: Candidate }) {
  const ref = candidate.sourceRef ?? {};
  const signal = (ref.signal ?? {}) as Record<string, unknown>;

  switch (candidate.source) {
    case "link": {
      const url = safeHttpUrl(ref.url);
      const platform = str(ref.platform) ?? "link";
      const title = str(ref.title) ?? url ?? "pasted link";
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 capitalize text-muted">{platform}</span>
          {url ? (
            <ExternalAnchor href={url} title={url}>
              {title}
            </ExternalAnchor>
          ) : (
            <span className="truncate">{title}</span>
          )}
        </span>
      );
    }
    case "wikipedia_top": {
      const article = str(signal.article);
      const rank = num(signal.rank);
      const views = num(signal.views);
      const label = ["Wikipedia most read", rank !== null ? `#${rank}` : null, views !== null ? `${formatNumber(views)} views` : null].filter(Boolean).join(" · ");
      return article ? <ExternalAnchor href={wikipediaUrl(article)}>{label}</ExternalAnchor> : <span className="truncate">{label}</span>;
    }
    case "elfa_trending": {
      const token = str(signal.token);
      const mentions = num(signal.mentions24h);
      const change = num(signal.changePercent);
      const label = [
        "Elfa trending",
        token ? `$${token.toUpperCase()}` : null,
        mentions !== null ? `${formatNumber(mentions)} mentions` : null,
        change !== null ? `${change >= 0 ? "+" : ""}${Math.round(change)}%` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return <span className="truncate">{label}</span>;
    }
    case "elfa_narrative": {
      const text = str(signal.text);
      const links = Array.isArray(signal.links) ? signal.links.map(safeHttpUrl).filter((u): u is string => u !== null) : [];
      return (
        <span className="flex min-w-0 items-center gap-1.5" title={text ?? undefined}>
          <span className="shrink-0">Elfa narrative</span>
          {links[0] && <ExternalAnchor href={links[0]}>post</ExternalAnchor>}
        </span>
      );
    }
    case "coingecko_trending":
    case "geckoterminal_trending": {
      const token = str(signal.token);
      const rank = num(signal.marketCapRank);
      const volume = num(signal.volume24hUsd);
      const change = num(signal.changePercent);
      const gecko = candidate.source === "coingecko_trending";
      const label = [
        gecko ? "CoinGecko trending" : `GeckoTerminal pool${str(signal.network) ? ` on ${str(signal.network)}` : ""}`,
        token ? `$${token.toUpperCase()}` : null,
        rank !== null ? `rank ${rank}` : null,
        volume !== null ? `$${formatNumber(volume)} volume` : null,
        change !== null ? `${change >= 0 ? "+" : ""}${Math.round(change)}%` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const credit = candidate.attribution ?? (gecko ? { text: "Data from CoinGecko", url: "https://www.coingecko.com" } : { text: "Data from GeckoTerminal", url: "https://www.geckoterminal.com" });
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{label}</span>
          <ExternalAnchor href={credit.url}>{credit.text}</ExternalAnchor>
        </span>
      );
    }
    case "bluesky_trend": {
      const text = str(signal.text);
      const posts = num(signal.postCount);
      const link = safeHttpUrl(signal.link);
      const label = ["Bluesky trending", posts !== null ? `${formatNumber(posts)} posts` : null, str(signal.status)].filter(Boolean).join(" · ");
      return (
        <span className="flex min-w-0 items-center gap-1.5" title={text ?? undefined}>
          {link ? <ExternalAnchor href={link}>{label}</ExternalAnchor> : <span className="truncate">{label}</span>}
        </span>
      );
    }
    case "seed":
      return <span>Seed list</span>;
    case "manual":
      return <span>Added by hand</span>;
    default:
      return <span>{candidate.source}</span>;
  }
}

/** The narrative text Elfa reported, or Bluesky's description of a trending topic, when the candidate came from one. */
export function narrativeText(candidate: Candidate): string | null {
  const signal = candidate.sourceRef?.signal as Record<string, unknown> | undefined;
  if (candidate.source === "bluesky_trend") return str(signal?.description) ?? str(signal?.text);
  if (candidate.source !== "elfa_narrative") return null;
  return str(signal?.text);
}

export function actorLabel(actor: string | null): string | null {
  if (!actor) return null;
  if (actor === "radar") return "Radar";
  return shortAddress(actor);
}
