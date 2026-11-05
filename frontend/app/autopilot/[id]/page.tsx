import type { Metadata } from "next";
import { PageTransition } from "@/components/shell/PageTransition";
import RuleDetail from "@/features/autopilot/detail/RuleDetail";

export const metadata: Metadata = { title: "Autopilot rule" };

export default async function Page(props: PageProps<"/autopilot/[id]">) {
  const { id } = await props.params;
  const n = Number(id);
  return (
    <PageTransition>
      <RuleDetail id={Number.isInteger(n) && n > 0 ? n : null} />
    </PageTransition>
  );
}
