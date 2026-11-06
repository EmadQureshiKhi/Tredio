"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/src/components/ui/Button";
import { Dialog } from "@/src/components/ui/Dialog";
import { describedBy, Field, inputClass } from "@/src/components/ui/Field";
import { Notice } from "@/src/components/ui/Notice";
import { useToast } from "@/src/components/ui/Toasts";
import { api, ApiError } from "@/src/lib/api";
import { shortAddress } from "@/src/lib/format";
import type { ModeratedCall, ModeratedPost, SocialCaller } from "@/src/types/admin";
import { BIO_MAX, Direction, HANDLE, horizonLabel, moderationKey, noun, REASON_MAX } from "./parts";

export type Moderating = { kind: "posts"; item: ModeratedPost } | { kind: "calls"; item: ModeratedCall };

/** The reason every moderation action asks for; it is kept in the log with the admin's account. */
function ReasonField({ id, value, onChange, placeholder }: { id: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  const tooLong = value.length > REASON_MAX;
  return (
    <Field id={id} label="Reason" counter={{ value: value.length, max: REASON_MAX }} error={tooLong ? `At most ${REASON_MAX} characters.` : undefined} hint="Kept in the moderation log with your account.">
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputClass(tooLong, "h-9")} {...describedBy(id, tooLong, true)} />
    </Field>
  );
}

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/**
 * Hides a call or post from every public view, or restores one, with a reason for the log. The row
 * itself never changes: it stays as its caller signed it.
 */
export function ModerateDialog({ target, onClose }: { target: Moderating; onClose: () => void }) {
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const notify = useToast();
  const queryClient = useQueryClient();
  const { kind, item } = target;
  const hide = item.hiddenAt === null;
  const what = `${noun(kind)} #${item.id}`;
  const valid = reason.trim().length > 0 && reason.length <= REASON_MAX;

  const act = useMutation({
    mutationFn: () => api.moderate(kind, item.id, hide ? "hide" : "restore", reason.trim()),
    onSuccess: () => {
      notify({
        tone: "ok",
        title: `${hide ? "Hid" : "Restored"} ${what}`,
        description: hide ? "It no longer shows in any public view." : kind === "calls" ? "It shows again and counts in the caller's record." : "It shows in the trend's thread again.",
      });
      void queryClient.invalidateQueries({ queryKey: moderationKey });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      locked={act.isPending}
      title={`${hide ? "Hide" : "Restore"} ${what}?`}
      description={`${item.handle ? `@${item.handle}` : shortAddress(item.caller)} on ${item.identifier}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={act.isPending}>
            Cancel
          </Button>
          <Button
            variant={hide ? "danger" : "primary"}
            icon={hide ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
            loading={act.isPending}
            disabled={!valid}
            onClick={() => act.mutate()}
          >
            {hide ? `Hide ${noun(kind)}` : `Restore ${noun(kind)}`}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm leading-6 text-muted">
          {hide
            ? `It leaves the trend's thread, the caller's profile${kind === "calls" ? " and record, the leaderboard and its share link" : ""}. The signed original stays, and restoring brings it back as it was.`
            : `It shows again in the trend's thread and on the caller's profile${kind === "calls" ? ", and counts in their record and on the leaderboard" : ""}.`}
        </p>
        <ContentPreview target={target} />
        <ReasonField id={reasonId} value={reason} onChange={setReason} placeholder={hide ? "Spam, abuse, off topic" : "Hidden by mistake"} />
        {act.error ? <Notice tone="bad">{errorText(act.error, `The ${noun(kind)} could not be ${hide ? "hidden" : "restored"}.`)}</Notice> : null}
      </div>
    </Dialog>
  );
}

function ContentPreview({ target }: { target: Moderating }) {
  const box = "max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-raised px-3 py-2 text-sm leading-6 text-fg";
  if (target.kind === "posts") return <p className={box}>{target.item.body}</p>;
  const c = target.item;
  return (
    <div className={box}>
      <p className="flex flex-wrap items-center gap-x-1.5">
        <Direction direction={c.direction} />
        <span className="text-muted">
          from <span className="tabular-nums text-fg">{c.openingIndex.toFixed(2)}</span> over {horizonLabel(c.horizonSec)}
        </span>
      </p>
      {c.note ? <p className="mt-1">{c.note}</p> : <p className="mt-1 text-subtle">No note.</p>}
    </div>
  );
}

/**
 * Replaces a caller's handle and bio: plain profile metadata the caller can change at any time, so an
 * admin may too (a handle that breaks the rules, or a profile whose key is lost).
 */
export function RenameDialog({ caller, onClose }: { caller: SocialCaller; onClose: () => void }) {
  const ids = { handle: useId(), bio: useId(), reason: useId() };
  const [handle, setHandle] = useState(caller.handle ?? "");
  const [bio, setBio] = useState(caller.bio ?? "");
  const [reason, setReason] = useState("");
  const notify = useToast();
  const queryClient = useQueryClient();
  const problems = {
    handle: HANDLE.test(handle) ? undefined : "3 to 20 of a-z, 0-9 and _.",
    bio: bio.length > BIO_MAX ? `At most ${BIO_MAX} characters.` : undefined,
  };
  const changed = handle !== (caller.handle ?? "") || bio !== (caller.bio ?? "");
  const valid = !problems.handle && !problems.bio && changed && reason.trim().length > 0 && reason.length <= REASON_MAX;

  const save = useMutation({
    mutationFn: () => api.renameCaller(caller.address, { handle, bio, reason: reason.trim() }),
    onSuccess: (c) => {
      notify({ tone: "ok", title: `Saved @${c.handle}`, description: "The caller's profile shows the new handle and bio." });
      void queryClient.invalidateQueries({ queryKey: moderationKey });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      locked={save.isPending}
      title={caller.handle ? `Edit @${caller.handle}` : "Edit caller profile"}
      description={caller.address}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>
            Save profile
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm leading-6 text-muted">The handle and bio are the only things an admin can change on a profile. Calls and posts stay as the caller signed them; the caller can change both again at any time.</p>
        <Field id={ids.handle} label="Handle" error={handle ? problems.handle : undefined} hint="3 to 20 of a-z, 0-9 and _; it must not be taken.">
          <input
            id={ids.handle}
            value={handle}
            onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/^@/, ""))}
            autoComplete="off"
            spellCheck={false}
            className={inputClass(Boolean(handle && problems.handle), "h-9 font-mono")}
            {...describedBy(ids.handle, Boolean(handle && problems.handle), true)}
          />
        </Field>
        <Field id={ids.bio} label="Bio" counter={{ value: bio.length, max: BIO_MAX }} error={problems.bio}>
          <textarea id={ids.bio} value={bio} onChange={(e) => setBio(e.target.value)} rows={2} className={inputClass(Boolean(problems.bio), "py-2")} {...describedBy(ids.bio, Boolean(problems.bio), Boolean(problems.bio))} />
        </Field>
        <ReasonField id={ids.reason} value={reason} onChange={setReason} placeholder="The handle broke the rules" />
        {save.error ? <Notice tone="bad">{errorText(save.error, "The profile could not be saved.")}</Notice> : null}
      </div>
    </Dialog>
  );
}
