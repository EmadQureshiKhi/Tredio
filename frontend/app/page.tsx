import { PageTransition } from "@/components/shell/PageTransition";
import Home from "@/features/home/Home";

export default function Page() {
  return (
    <PageTransition>
      <Home />
    </PageTransition>
  );
}
