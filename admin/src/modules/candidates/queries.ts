import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/src/lib/api";
import type { Candidate, CandidateStatus, DecisionRequest } from "@/src/types/admin";

/** Every admin query sits under ["admin"], which is dropped on sign-out. */
export const candidatesKey = (status: CandidateStatus | null) => ["admin", "candidates", status ?? "all"] as const;

/**
 * Records a decision and moves the returned row into place in every cached list at once (lists
 * are ordered by last update, so it goes first), then refetches them to settle.
 */
export function useDecision() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: DecisionRequest }) => api.decide(id, body),
    onSuccess: (updated) => {
      for (const [key, rows] of queryClient.getQueriesData<Candidate[]>({ queryKey: ["admin", "candidates"] })) {
        if (!rows) continue;
        const filter = key[2];
        const others = rows.filter((c) => c.id !== updated.id);
        queryClient.setQueryData<Candidate[]>(key, filter === "all" || filter === updated.status ? [updated, ...others] : others);
      }
      void queryClient.invalidateQueries({ queryKey: ["admin", "candidates"] });
    },
  });
}
