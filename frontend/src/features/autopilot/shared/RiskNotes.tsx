import { AlertTriangle, Coins, History, Zap } from "lucide-react";
import { cn } from "@/components/ui";
import { IS_MAINNET } from "@/lib/config";

/**
 * The plain risks of automated leveraged trading, said before anything runs. With a leverage the
 * liquidation distance is worked out for that rule.
 */
export function RiskNotes({ leverage, maintenanceMargin = 0, className }: { leverage?: number; maintenanceMargin?: number; className?: string }) {
  const lev = leverage && Number.isFinite(leverage) && leverage >= 1 ? leverage : null;
  const liq = lev ? Math.max(0, (1 / lev - maintenanceMargin) * 100) : null;
  const items = [
    {
      icon: Zap,
      title: "Leverage cuts both ways",
      body: lev
        ? `At ${fmt(lev)}x, a price move of about ${fmt(liq!)}% against the position liquidates it and loses its margin; fees and funding bring that point closer.`
        : "Leverage multiplies gains and losses. A large enough move against a position liquidates it and loses its margin.",
    },
    {
      icon: History,
      title: "Past attention does not predict prices",
      body: "A backtest shows what the rule would have done over a window of history, not what it will do next. Attention can spike without the price following.",
    },
    {
      icon: Coins,
      title: "Trading fees and funding apply",
      body: "Every fill pays the market's trading fee and open positions pay or receive funding. Both come out of the result.",
    },
    {
      icon: AlertTriangle,
      title: "It acts on its own",
      body: `While a rule runs, Autopilot opens and closes positions without asking. Pause it to open nothing new, or stop it to close everything.${IS_MAINNET ? "" : " This is Testnet: test funds only."}`,
    },
  ];
  return (
    <ul className={cn("flex flex-col gap-3.5", className)} data-testid="risk-notes">
      {items.map(({ icon: Icon, title, body }) => (
        <li key={title} className="flex gap-3">
          <Icon className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <div className="min-w-0">
            <p className="font-strong text-[13.5px] leading-5 text-text">{title}</p>
            <p className="mt-0.5 text-[13px] leading-5 text-text-2">{body}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v >= 10 ? v.toFixed(0) : v.toFixed(1));
