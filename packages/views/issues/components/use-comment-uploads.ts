"use client";

/**
 * Coordinated file uploads for the comment composers (MUL-5181, L2).
 *
 * Ownership inversion: the upload is owned by the module-level upload
 * coordinator, not this component. On file pick we write a persisted
 * placeholder into the comment draft IMMEDIATELY, then hand the file to the
 * coordinator. Closing or scrolling the composer away no longer aborts the
 * upload — its result lands in the draft through `onSettled`, so reopening the
 * composer shows the attachment, and a placeholder still "uploading" at reload
 * time surfaces as "interrupted" (the store coerces it on rehydrate).
 *
 * `onSettled` is generation-guarded here: it re-reads the draft and only writes
 * if the placeholder is still tracked (the draft may have been submitted or
 * cleared while the request was in flight). The coordinator never calls
 * `onSettled` on abort, so logout — which aborts every upload then clears the
 * drafts — cannot resurrect a placeholder into a wiped draft.
 *
 * The returned `handleUpload` resolves the editor's `onUploadFile` promise so
 * the happy-path inline preview (blob node → real URL) still works. The SOURCE
 * OF TRUTH for what a submit binds is the draft BODY (reference-filtered, like
 * every other composer): an upload that settles after its mount died gets its
 * link written back into the body — via the reopened composer's live editor
 * when one exists, else appended to the persisted draft — so the file is
 * visible, deletable, and deleting it really unbinds it.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo, type RefObject } from "react";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import { startUpload, hasUploadingDraft, type DraftUpload } from "@multica/core/drafts";
import { attachmentToDraftUpload } from "@multica/core/drafts";
import type { UploadGate, ContentEditorRef } from "../../editor";
import { createSafeId } from "@multica/core/utils";
import { contentReferencesAttachment, type Attachment } from "@multica/core/types";
import {
  toUploadResult,
  type UploadContext,
  type UploadResult,
} from "@multica/core/hooks/use-file-upload";
import { MAX_FILE_SIZE } from "@multica/core/constants/upload";
import { useCommentDraftStore, type CommentDraftKey } from "@multica/core/issues/stores";
import { useT } from "../../i18n";

const EMPTY_UPLOADS: DraftUpload[] = [];
const EMPTY_ATTACHMENTS: Attachment[] = [];

// The editor currently showing each draft key. Lets a settle handler whose own
// mount is gone (the upload outlived the composer) hand the finished link to
// the editor a REOPENED composer mounted for the same draft.
const liveEditors = new Map<CommentDraftKey, RefObject<ContentEditorRef | null>>();

/** Markdown for a finished upload. Mirrors the shape the in-editor swap
 *  produces (`extensions/file-upload.ts`: image node for images, fileCard link
 *  for everything else) — keep the two in sync. */
function attachmentMarkdown(att: Attachment): string {
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
 *    `appendToDraftContent` as insurance — the editor's debounced emit is
 *    dropped on a quick unmount, and it converges to identical content anyway.
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
  draftKey: CommentDraftKey,
  clientUploadId: string,
  attachment: Attachment,
  tries = 0,
): void {
  const store = useCommentDraftStore.getState();
  if (!store.getUploads(draftKey).some((u) => u.clientUploadId === clientUploadId)) return;
  if (contentReferencesAttachment(store.getDraft(draftKey) ?? "", attachment)) return;

  const md = attachmentMarkdown(attachment);
  const live = liveEditors.get(draftKey);
  if (live?.current?.insertMarkdownAtEnd(md) === true) {
    store.appendToDraftContent(draftKey, md);
    return;
  }
  if (!live) {
    store.appendToDraftContent(draftKey, md);
    return;
  }
  if (tries >= DELIVER_MAX_TRIES) {
    // Editor never initialized — persist to the store as the least-bad option.
    store.appendToDraftContent(draftKey, md);
    return;
  }
  setTimeout(
    () => deliverFinishedUpload(draftKey, clientUploadId, attachment, tries + 1),
    DELIVER_RETRY_MS,
  );
}

export interface CommentUploads {
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
 * @param draftKey  When set, uploads persist in the comment draft store and
 *                  survive unmount. When absent (a reply box with no persistence
 *                  context) they fall back to component-local state.
 */
export function useCommentUploads(
  draftKey: CommentDraftKey | undefined,
  ctx: UploadContext,
  editorGate: UploadGate,
  editorRef: RefObject<ContentEditorRef | null>,
): CommentUploads {
  const { t } = useT("editor");
  const [localUploads, setLocalUploads] = useState<DraftUpload[]>([]);

  // Liveness of THIS mount, read by settle closures it created: while true,
  // the editor that started the upload will do the inline swap itself; once
  // false, the write-back below is the only path that lands the link.
  // Layout effect on purpose: React nulls the child editor's ref during the
  // unmount commit, but a passive cleanup flips this a task later — a settle
  // landing in that gap would see "mounted" with no editor left to swap.
  const mountedRef = useRef(true);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!draftKey) return;
    liveEditors.set(draftKey, editorRef);
    return () => {
      if (liveEditors.get(draftKey) === editorRef) liveEditors.delete(draftKey);
    };
  }, [draftKey, editorRef]);

  const storeUploads = useCommentDraftStore((s) =>
    draftKey ? s.getUploads(draftKey) : EMPTY_UPLOADS,
  );
  const storeAttachments = useCommentDraftStore((s) =>
    draftKey ? s.getAttachments(draftKey) : EMPTY_ATTACHMENTS,
  );

  const uploads = draftKey ? storeUploads : localUploads;
  const localAttachments = useMemo(() => {
    if (draftKey) return EMPTY_ATTACHMENTS;
    const done = localUploads.filter((u) => u.status === "uploaded");
    return done.length === 0
      ? EMPTY_ATTACHMENTS
      : done.map((u) => (u as { attachment: Attachment }).attachment);
  }, [draftKey, localUploads]);
  const attachments = draftKey ? storeAttachments : localAttachments;

  const issueId = ctx.issueId;
  const commentId = ctx.commentId;
  const chatSessionId = ctx.chatSessionId;

  const handleUpload = useCallback(
    (file: File): Promise<UploadResult | null> => {
      const clientUploadId = createSafeId();
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
        if (draftKey) {
          useCommentDraftStore.getState().addUpload(draftKey, placeholder);
          useCommentDraftStore.getState().failUpload(draftKey, clientUploadId, reason);
        } else {
          setLocalUploads((prev) => [
            ...prev,
            { clientUploadId, status: "failed", filename: file.name, size: file.size, error: reason },
          ]);
        }
        toast.error(t(($) => $.upload.failed, { filename: file.name, reason }));
        return Promise.resolve(null);
      }

      if (draftKey) {
        useCommentDraftStore.getState().addUpload(draftKey, placeholder);
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
              if (draftKey) {
                const store = useCommentDraftStore.getState();
                // Generation guard: only write if the draft still tracks it.
                if (store.getUploads(draftKey).some((u) => u.clientUploadId === clientUploadId)) {
                  store.settleUpload(draftKey, clientUploadId, outcome.attachment);
                  // Write-back (MUL-5181): the mount that started this upload
                  // is gone, so no editor swap will put the finished link into
                  // the document — deliver it into the BODY instead (that is
                  // what submit binds, reference-filtered). Skipped while this
                  // mount is alive: resolving the promise below drives the
                  // normal inline blob→URL swap, and a placeholder the user
                  // deleted mid-upload must stay deleted.
                  if (!mountedRef.current) {
                    deliverFinishedUpload(draftKey, clientUploadId, outcome.attachment);
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
              if (draftKey) {
                const store = useCommentDraftStore.getState();
                if (store.getUploads(draftKey).some((u) => u.clientUploadId === clientUploadId)) {
                  store.failUpload(draftKey, clientUploadId, reason);
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
    [draftKey, issueId, commentId, chatSessionId, t],
  );

  const removeUpload = useCallback(
    (clientUploadId: string) => {
      if (draftKey) useCommentDraftStore.getState().removeUpload(draftKey, clientUploadId);
      else setLocalUploads((prev) => prev.filter((u) => u.clientUploadId !== clientUploadId));
    },
    [draftKey],
  );

  // Submit-time truth for the local (non-persisted) path: a deliberate
  // latest-value ref written during render, because `isBlocked` must read the
  // value at invocation time, not at the render the callback captured. The
  // persisted path reads the store directly.
  const localUploadsRef = useRef(localUploads);
  localUploadsRef.current = localUploads;

  // Rebuilt every render on purpose (editorGate itself is a fresh object per
  // render): consumers read it through refs/props, never by identity.
  const gate: UploadGate = {
    uploading: editorGate.uploading || hasUploadingDraft(uploads),
    onUploadingChange: editorGate.onUploadingChange,
    isBlocked: () =>
      editorGate.isBlocked() ||
      hasUploadingDraft(
        draftKey
          ? useCommentDraftStore.getState().getUploads(draftKey)
          : localUploadsRef.current,
      ),
  };

  return { uploads, attachments, handleUpload, removeUpload, gate };
}
