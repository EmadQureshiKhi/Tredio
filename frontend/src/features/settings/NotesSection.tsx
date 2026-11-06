"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Fingerprint, Lock, PenLine, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { PrivateIdentity } from "@/lib/account/service";
import { Button, Empty, ErrorNote, Field, Skeleton } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { ApiError, vault, type VaultItem } from "@/lib/api";
import { ago } from "@/lib/format";
import { notify } from "@/lib/toast";
import { StaleNote, TextArea, useConfirm } from "@/features/autopilot/shared/kit";
import { dropIdentityToken, identityToken, useCallerIdentity } from "@/features/callers/identity";
import { Section } from "./Section";
import { newItemId, type Note, seal, unseal } from "./vault";

interface Opened {
  item: VaultItem;
  note: Note | null;
}

/** Private notes, sealed on this device; the server keeps ciphertext only. */
export function NotesSection() {
  const account = useAccount();
  const me = useCallerIdentity();
  return (
    <Section
      id="notes"
      title="Private notes"
      description="Theses, watchlists, reminders. Sealed on this device with a key your passkey derives, so they follow you to any device and nobody else can read them."
    >
      {!account.authenticated ? (
        <Button onClick={account.login} icon={<Fingerprint className="size-4" aria-hidden />}>
          Sign in
        </Button>
      ) : !me.available ? (
        <p className="rounded-2xl border border-line p-4 text-[13.5px] leading-5 text-text-2">Notes are sealed with a key a passkey derives. A NEAR wallet cannot derive one, so private notes need a passkey account.</p>
      ) : !me.identity ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13.5px] leading-5 text-text-2">This device does not hold your notes key yet.</p>
          {me.unlockError ? <ErrorNote message={me.unlockError} /> : null}
          <Button className="self-start" loading={me.unlocking} icon={<Fingerprint className="size-4" aria-hidden />} onClick={me.unlock}>
            Unlock with passkey
          </Button>
        </div>
      ) : (
        <Notes identity={me.identity} />
      )}
    </Section>
  );
}

function Notes({ identity }: { identity: PrivateIdentity }) {
  const account = useAccount();
  const key = account.privateIdentity!.vaultKey;
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const notes = useQuery({
    queryKey: ["vault-notes", identity.id],
    queryFn: async (): Promise<Opened[]> => {
      const load = async () => (await vault.list(await identityToken(identity), "note")).items;
      const items = await load().catch(async (e) => {
        if (e instanceof ApiError && e.status === 401) {
          dropIdentityToken();
          return load();
        }
        throw e;
      });
      return Promise.all(items.map(async (item) => ({ item, note: await unseal<Note>(key, "note", item.item_id, item).catch(() => null) })));
    },
    retry: 1,
  });
  const list = [...(notes.data ?? [])].sort((a, b) => (b.note?.editedAt ?? 0) - (a.note?.editedAt ?? 0));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-2xl bg-primary-soft px-4 py-3">
        <Lock className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <p className="text-[12.5px] leading-[18px] text-text">Encrypted here before upload (AES-256-GCM). Tredio&rsquo;s server stores only ciphertext and cannot read, search or recover a note. Open &ldquo;Server&rsquo;s copy&rdquo; on any note to see exactly what it holds.</p>
      </div>
      {notes.error ? notes.data ? <StaleNote onRetry={() => void notes.refetch()} what="your notes" /> : <ErrorNote message={notes.error instanceof Error ? notes.error.message : "Your notes could not load."} onRetry={() => void notes.refetch()} /> : null}
      {editing === "new" ? (
        <NoteEditor
          identity={identity}
          onDone={() => setEditing(null)}
          onSaved={() => qc.invalidateQueries({ queryKey: ["vault-notes", identity.id] })}
        />
      ) : (
        <Button className="self-start" tone="secondary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setEditing("new")} data-testid="note-new">
          New note
        </Button>
      )}
      {notes.isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-20 rounded-2xl" />
          <Skeleton className="h-20 rounded-2xl" />
        </div>
      ) : list.length === 0 && editing !== "new" ? (
        <Empty className="py-6" title="No notes yet" body="Write down why you took a trade; future you will want to know." />
      ) : (
        <ul className="flex flex-col gap-2.5" data-testid="note-list">
          {list.map((o) =>
            editing === o.item.item_id && o.note ? (
              <li key={o.item.item_id}>
                <NoteEditor identity={identity} existing={o} onDone={() => setEditing(null)} onSaved={() => qc.invalidateQueries({ queryKey: ["vault-notes", identity.id] })} />
              </li>
            ) : (
              <li key={o.item.item_id}>
                <NoteCard identity={identity} o={o} onEdit={() => setEditing(o.item.item_id)} />
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function NoteCard({ identity, o, onEdit }: { identity: PrivateIdentity; o: Opened; onEdit: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [raw, setRaw] = useState(false);
  const remove = useMutation({
    mutationFn: async () => vault.remove(await identityToken(identity), "note", o.item.item_id),
    onSuccess: async () => {
      notify.success("Note deleted");
      await qc.invalidateQueries({ queryKey: ["vault-notes", identity.id] });
    },
    onError: (e) => notify.error("Could not delete the note", e instanceof Error ? e.message : "Try again."),
  });
  return (
    <article className="rounded-2xl border border-line p-4" data-testid="note-card" data-note-id={o.item.item_id}>
      {o.note ? (
        <>
          <div className="flex items-start justify-between gap-3">
            <h3 className="min-w-0 break-words font-strong text-[14px] leading-5 text-text">{o.note.title || "Untitled"}</h3>
            <span className="shrink-0 text-[11.5px] text-text-3">{ago(o.note.editedAt / 1000)}</span>
          </div>
          {o.note.body ? <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap break-words text-[13px] leading-5 text-text-2">{o.note.body}</p> : null}
        </>
      ) : (
        <p className="text-[13px] text-warn">This note could not be opened with this passkey&rsquo;s key.</p>
      )}
      {raw ? (
        <div className="mt-3 flex flex-col gap-1 rounded-xl bg-surface-2 p-3" data-testid="note-ciphertext">
          <p className="text-[11.5px] uppercase tracking-[0.08em] text-text-3">What the server stores · version {o.item.version}</p>
          <p className="num break-all font-mono text-[11.5px] leading-4 text-text-2">{o.item.ciphertext.length > 220 ? `${o.item.ciphertext.slice(0, 220)}…` : o.item.ciphertext}</p>
          <p className="num font-mono text-[11.5px] text-text-3">iv {o.item.iv}</p>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {o.note ? (
          <Button size="sm" tone="ghost" icon={<PenLine className="size-3.5" aria-hidden />} onClick={onEdit} data-testid="note-edit">
            Edit
          </Button>
        ) : null}
        <Button size="sm" tone="ghost" icon={raw ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />} onClick={() => setRaw((r) => !r)} aria-expanded={raw} data-testid="note-raw">
          Server&rsquo;s copy
        </Button>
        <Button
          size="sm"
          tone={confirm.armed === "del" ? "danger" : "ghost"}
          className="ml-auto"
          icon={<Trash2 className="size-3.5" aria-hidden />}
          loading={remove.isPending}
          onBlur={confirm.disarm}
          onClick={() => confirm.confirm("del") && remove.mutate()}
          data-testid="note-delete"
        >
          {confirm.armed === "del" ? "Delete for good" : "Delete"}
        </Button>
      </div>
    </article>
  );
}

function NoteEditor({ identity, existing, onDone, onSaved }: { identity: PrivateIdentity; existing?: Opened; onDone: () => void; onSaved: () => Promise<unknown> }) {
  const account = useAccount();
  const key = account.privateIdentity!.vaultKey;
  const [title, setTitle] = useState(existing?.note?.title ?? "");
  const [body, setBody] = useState(existing?.note?.body ?? "");
  const save = useMutation({
    mutationFn: async () => {
      const id = existing?.item.item_id ?? newItemId();
      const version = (existing?.item.version ?? 0) + 1;
      const sealed = await seal(key, "note", id, { title: title.trim(), body: body.trim(), editedAt: Date.now() } satisfies Note);
      return vault.put(await identityToken(identity), "note", id, { ...sealed, version });
    },
    onSuccess: async () => {
      await onSaved();
      notify.success(existing ? "Note updated" : "Note saved", "Sealed on this device before it left.");
      onDone();
    },
  });
  const empty = !title.trim() && !body.trim();
  return (
    <form
      className="flex flex-col gap-3 rounded-2xl border border-primary/40 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!empty && body.length <= 5000) save.mutate();
      }}
      data-testid="note-editor"
    >
      <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value.slice(0, 120))} placeholder="ETH attention thesis" data-testid="note-title" autoFocus />
      <TextArea label="Note" value={body} onChange={setBody} max={5000} rows={5} placeholder="Only you can read this." testId="note-body" />
      {save.error ? <ErrorNote message={save.error instanceof ApiError ? save.error.message : save.error instanceof Error ? save.error.message : "The note could not be saved."} /> : null}
      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending} disabled={empty || body.length > 5000} icon={<Lock className="size-4" aria-hidden />} data-testid="note-save">
          Seal and save
        </Button>
        <Button tone="ghost" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
