import type { Metadata } from "next";
import { PageTransition } from "@/components/shell/PageTransition";
import RuleBuilder from "@/features/autopilot/builder/RuleBuilder";

export const metadata: Metadata = { title: "New Autopilot rule" };

const id = (v: string | string[] | undefined) => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** ?edit=<id> edits a draft or paused rule, ?from=<id> starts a new rule from one, ?trend= preselects a trend. */
export default async function Page(props: PageProps<"/autopilot/new">) {
  const q = await props.searchParams;
  const trend = typeof q.trend === "string" && /^[a-z0-9:._-]{1,64}$/.test(q.trend) ? q.trend : null;
  return (
    <PageTransition>
      <RuleBuilder editId={id(q.edit)} fromId={id(q.from)} trend={trend} />
    </PageTransition>
  );
}
