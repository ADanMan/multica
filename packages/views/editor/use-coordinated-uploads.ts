"use client";

/**
 * The coordinated-upload engine shared by every composer surface (MUL-5181, L2).
 *
 * Ownership inversion: an upload is owned by the module-level upload
 * coordinator (`@multica/core/drafts`), not by the React component that
 * started it. On file pick the engine writes a persisted placeholder into the
 * surface's draft IMMEDIATELY (through the {@link UploadDraftBinding}), then
 * hands the file to the coordinator. Closing or scrolling the composer away no
 * longer aborts the upload; logout aborts every tracked request; a placeholder
 * still `uploading` at load time is coerced to `interrupted` by the store.
 *
 * `onSettled` is generation-guarded: it re-reads the draft and only writes if
 * the placeholder is still tracked (the draft may have been submitted or
 * cleared while the request was in flight). The coordinator never calls
 * `onSettled` on abort, so logout — abort first, then clear drafts — cannot
 * resurrect a placeholder into a wiped draft.
 *
 * The SOURCE OF TRUTH for what a submit binds is the draft BODY
 * (reference-filtered): an upload that settles after its mount died gets its
 * markdown link delivered back into the body — into the reopened composer's
 * live editor when one exists (confirmed, with retry while the Tiptap instance
 * is still warming up), else appended to the persisted draft — so the file is
 * visible, deletable, and deleting it really unbinds it.
 *
 * A surface plugs in with a {@link UploadDraftBinding}: imperative, store-backed
 * accessors that must remain callable after the component unmounts. Bindings
 * MUST be referentially stable per target (memoize on the draft key).
 */

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import {
  startUpload,
  abortUpload,
  hasUploadingDraft,
  attachmentToDraftUpload,
  type DraftUpload,
} from "@multica/core/drafts";
import { createSafeId } from "@multica/core/utils";
import { contentReferencesAttachment, type Attachment } from "@multica/core/types";
import {
  toUploadResult,
  type UploadContext,
  type UploadResult,
} from "@multica/core/hooks/use-file-upload";
import { MAX_FILE_SIZE } from "@multica/core/constants/upload";
import { useT } from "../i18n";
import type { UploadGate } from "./use-upload-gate";
import type { ContentEditorRef } from "./content-editor";

const EMPTY_ATTACHMENTS: Attachment[] = [];

/**
 * Store-backed accessors for one composer target's uploads and body. Every
 * method must go through the store's `getState()` (never captured React
 * state): settle handlers call them after the owning component is gone.
 */
export interface UploadDraftBinding {
  /**
   * Identity for the live-editor registry — unique per composer target
   * (e.g. `comment:new:{issueId}`, `issue-create:manual`). A reopened
   * composer for the same target registers its editor under the same key,
   * which is how a settle handler finds it.
   */
  registryKey: string;
  getUploads: () => DraftUpload[];
  addUpload: (upload: DraftUpload) => void;
  settleUpload: (clientUploadId: string, attachment: Attachment) => void;
  failUpload: (clientUploadId: string, error?: string) => void;
  removeUpload: (clientUploadId: string) => void;
  /** The draft body reference-filtering binds against at submit time. */
  getBody: () => string;
  /** Append a markdown fragment to the persisted body. */
  appendToBody: (markdown: string) => void;
}

// The editor currently showing each registry key. Lets a settle handler whose
// own mount is gone (the upload outlived the composer) hand the finished link
// to the editor a REOPENED composer mounted for the same target.
const liveEditors = new Map<string, RefObject<ContentEditorRef | null>>();

/** Test-only: registry keys currently registered. Lets timing tests assert
 *  registration is part of the COMMIT (layout), not a passive task later. */
export function __liveEditorRegistryKeysForTest(): string[] {
  return [...liveEditors.keys()];
}

/** Markdown for a finished upload. Mirrors the shape the in-editor swap
 *  produces (`extensions/file-upload.ts`: image node for images, fileCard link
 *  for everything else) — keep the two in sync. */
export function attachmentMarkdown(att: Attachment): string {
  const link = toUploadResult(att).markdownLink;
  return (att.content_type ?? "").startsWith("image/")
    ? `![${att.filename}](${link})`
    : `[${att.filename}](${link})`;
}

const DELIVER_RETRY_MS = 50;
const DELIVER_MAX_TRIES = 100; // ~5s — editor init is a passive effect away

/**
 * Land a finished upload's markdown link in the draft BODY after the mount
 * that owned the upload died. Delivery must be CONFIRMED, not assumed:
 *
 *  - live editor for the key, insert landed → also persist the same body via
 *    `appendToBody` as insurance — the editor's debounced emit is dropped on a
 *    quick unmount, and it converges to identical content anyway.
 *  - no composer mounted for the key → append to the persisted draft; the next
 *    mount reads it as `defaultValue`.
 *  - composer mounted but its Tiptap instance not created yet (the handle
 *    exists from first commit; the instance arrives in a passive effect) →
 *    RETRY. Appending to the store here would be erased by the mounted
 *    editor's first emit, which snapshots a body without the link.
 *
 * Every attempt re-checks the generation guard (draft may be cleared or
 * submitted while waiting) and the body (the link may have landed some other
 * way) before writing.
 */
function deliverFinishedUpload(
  binding: UploadDraftBinding,
  clientUploadId: string,
  attachment: Attachment,
  tries = 0,
): void {
  if (!binding.getUploads().some((u) => u.clientUploadId === clientUploadId)) return;
  if (contentReferencesAttachment(binding.getBody(), attachment)) return;

  const md = attachmentMarkdown(attachment);
  const live = liveEditors.get(binding.registryKey);
  if (live?.current?.insertMarkdownAtEnd(md) === true) {
    binding.appendToBody(md);
    return;
  }
  if (!live) {
    binding.appendToBody(md);
    return;
  }
  if (tries >= DELIVER_MAX_TRIES) {
    // Editor never initialized — persist to the store as the least-bad option.
    binding.appendToBody(md);
    return;
  }
  setTimeout(
    () => deliverFinishedUpload(binding, clientUploadId, attachment, tries + 1),
    DELIVER_RETRY_MS,
  );
}

export interface CoordinatedUploads {
  /** Every upload for this composer (placeholders included) — for status chips. */
  uploads: DraftUpload[];
  /** Completed attachment rows — the editor preview set; submit binds the
   *  subset whose link the body still references. */
  attachments: Attachment[];
  /** Wire to `<ContentEditor onUploadFile={...} />`. */
  handleUpload: (file: File) => Promise<UploadResult | null>;
  /** Drop a placeholder (dismiss a failure / interrupted). */
  removeUpload: (clientUploadId: string) => void;
  /**
   * The submit gate for this composer. Combines the editor gate (this mount's
   * in-document uploads) with the coordinator-owned placeholders in the draft:
   * a composer reopened while a previous mount's upload is still in flight has
   * a clean editor document, so the editor gate alone would let a send clear
   * the draft out from under the settling upload — silently dropping the file
   * whose "uploading" chip is on screen.
   */
  gate: UploadGate;
}

/**
 * @param binding       Store-backed accessors for the persisted target. When
 *                      absent (a composer with no persistence context) uploads
 *                      fall back to component-local state and die with the
 *                      mount, matching pre-L2 behavior.
 * @param boundUploads  The binding's uploads as a REACTIVE value (the caller's
 *                      store subscription). Ignored when `binding` is absent.
 */
export function useCoordinatedUploads(
  binding: UploadDraftBinding | undefined,
  boundUploads: DraftUpload[],
  ctx: UploadContext,
  editorGate: UploadGate,
  editorRef: RefObject<ContentEditorRef | null>,
  opts?: {
    /**
     * Resolve the binding a NEW upload should target, snapshotted at pick
     * time. For composers whose single editor instance can hold a DIFFERENT
     * draft than the selected one (chat pins the document while an upload is
     * in flight): the file lands in the document the editor is HOLDING, so
     * its placeholder/settle/write-back must follow that draft, not whatever
     * is selected by the time the request finishes. Defaults to `binding`.
     */
    resolveUploadTarget?: () => UploadDraftBinding;
    /**
     * Registry key to register this mount's editor under, when it differs
     * from `binding.registryKey`. Same divergence as above: a write-back must
     * insert into the editor only if its DOCUMENT belongs to the settling
     * draft, so composers with a pinnable editor register the LOADED key.
     */
    liveRegistryKey?: string;
  },
): CoordinatedUploads {
  const { t } = useT("editor");
  const [localUploads, setLocalUploads] = useState<DraftUpload[]>([]);
  // Latest-value ref: handleUpload snapshots the target at invocation time.
  const resolveUploadTargetRef = useRef(opts?.resolveUploadTarget);
  resolveUploadTargetRef.current = opts?.resolveUploadTarget;

  // Liveness of THIS mount, read by settle closures it created: while true,
  // the editor that started the upload will do the inline swap itself; once
  // false, the write-back is the only path that lands the link. Layout effect
  // on purpose: React nulls the child editor's ref during the unmount commit,
  // but a passive cleanup flips this a task later — a settle landing in that
  // gap would see "mounted" with no editor left to swap.
  const mountedRef = useRef(true);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Registration only exists for a persisted target; a liveRegistryKey with
  // no binding would register an editor nothing can ever look up.
  const registryKey = binding ? (opts?.liveRegistryKey ?? binding.registryKey) : undefined;
  // Layout effect for the same reason as mountedRef: chat's adopt swaps the
  // editor's document (and its loaded key) synchronously during commit, and a
  // passive re-registration one task later leaves a settle window where the
  // old key still maps to an editor now holding another draft's document.
  useLayoutEffect(() => {
    if (!registryKey) return;
    liveEditors.set(registryKey, editorRef);
    return () => {
      if (liveEditors.get(registryKey) === editorRef) liveEditors.delete(registryKey);
    };
  }, [registryKey, editorRef]);

  const uploads = binding ? boundUploads : localUploads;
  const attachments = useMemo(() => {
    const done: Attachment[] = [];
    for (const u of uploads) {
      if (u.status === "uploaded") done.push(u.attachment);
    }
    return done.length === 0 ? EMPTY_ATTACHMENTS : done;
  }, [uploads]);

  const issueId = ctx.issueId;
  const commentId = ctx.commentId;
  const chatSessionId = ctx.chatSessionId;

  const handleUpload = useCallback(
    (file: File): Promise<UploadResult | null> => {
      const clientUploadId = createSafeId();
      // Snapshot the target NOW: settle handlers must keep addressing the
      // draft the file landed in, no matter what is selected when they fire.
      const target = binding ? (resolveUploadTargetRef.current?.() ?? binding) : undefined;
      const placeholder: DraftUpload = {
        clientUploadId,
        status: "uploading",
        filename: file.name,
        size: file.size,
        contentType: file.type || undefined,
      };

      if (file.size > MAX_FILE_SIZE) {
        // Never enters the coordinator — surface it as a failed placeholder so
        // the composer shows the reason instead of silently dropping the file.
        const reason = "File exceeds 100 MB limit";
        if (target) {
          target.addUpload(placeholder);
          target.failUpload(clientUploadId, reason);
        } else {
          setLocalUploads((prev) => [
            ...prev,
            { clientUploadId, status: "failed", filename: file.name, size: file.size, error: reason },
          ]);
        }
        toast.error(t(($) => $.upload.failed, { filename: file.name, reason }));
        return Promise.resolve(null);
      }

      if (target) {
        target.addUpload(placeholder);
      } else {
        setLocalUploads((prev) => [...prev, placeholder]);
      }

      return new Promise<UploadResult | null>((resolve) => {
        startUpload({
          clientUploadId,
          file,
          api,
          ctx: { issueId, commentId, chatSessionId },
          onSettled: (outcome) => {
            if (outcome.status === "uploaded") {
              if (target) {
                // Generation guard: only write if the draft still tracks it.
                if (target.getUploads().some((u) => u.clientUploadId === clientUploadId)) {
                  target.settleUpload(clientUploadId, outcome.attachment);
                  // Write-back (MUL-5181): the mount that started this upload
                  // is gone, so no editor swap will put the finished link into
                  // the document — deliver it into the BODY instead (that is
                  // what submit binds, reference-filtered). Skipped while this
                  // mount is alive: resolving the promise below drives the
                  // normal inline blob→URL swap, and a placeholder the user
                  // deleted mid-upload must stay deleted.
                  if (!mountedRef.current) {
                    deliverFinishedUpload(target, clientUploadId, outcome.attachment);
                  }
                }
              } else {
                setLocalUploads((prev) =>
                  prev.map((u) =>
                    u.clientUploadId === clientUploadId
                      ? { ...attachmentToDraftUpload(outcome.attachment), clientUploadId }
                      : u,
                  ),
                );
              }
              resolve(toUploadResult(outcome.attachment));
            } else {
              const reason = outcome.error.message;
              if (target) {
                if (target.getUploads().some((u) => u.clientUploadId === clientUploadId)) {
                  target.failUpload(clientUploadId, reason);
                }
              } else {
                setLocalUploads((prev) =>
                  prev.map((u) =>
                    u.clientUploadId === clientUploadId
                      ? { clientUploadId, status: "failed", filename: file.name, size: file.size, error: reason }
                      : u,
                  ),
                );
              }
              toast.error(t(($) => $.upload.failed, { filename: file.name, reason }));
              resolve(null);
            }
          },
        });
      });
    },
    [binding, issueId, commentId, chatSessionId, t],
  );

  const removeUpload = useCallback(
    (clientUploadId: string) => {
      // Defensive cancel for a placeholder removed while still in flight: its
      // request has no destination left, so don't let it run to completion.
      // Today's chips expose ✕ only for failed/interrupted entries, so this
      // fires only if a future caller removes an `uploading` one. Guarded on
      // OUR tracking so a stray id can never abort another surface's upload.
      const tracked = binding ? binding.getUploads() : localUploadsRef.current;
      if (tracked.some((u) => u.clientUploadId === clientUploadId && u.status === "uploading")) {
        abortUpload(clientUploadId);
      }
      if (binding) binding.removeUpload(clientUploadId);
      else setLocalUploads((prev) => prev.filter((u) => u.clientUploadId !== clientUploadId));
    },
    [binding],
  );

  // Submit-time truth for the local (non-persisted) path: a deliberate
  // latest-value ref written during render, because `isBlocked` must read the
  // value at invocation time, not at the render the callback captured. The
  // persisted path reads the store through the binding.
  const localUploadsRef = useRef(localUploads);
  localUploadsRef.current = localUploads;

  // Rebuilt every render on purpose (editorGate itself is a fresh object per
  // render): consumers read it through refs/props, never by identity.
  const gate: UploadGate = {
    uploading: editorGate.uploading || hasUploadingDraft(uploads),
    onUploadingChange: editorGate.onUploadingChange,
    isBlocked: () =>
      editorGate.isBlocked() ||
      hasUploadingDraft(binding ? binding.getUploads() : localUploadsRef.current),
  };

  return { uploads, attachments, handleUpload, removeUpload, gate };
}
