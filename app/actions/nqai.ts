"use server"

import type { UIMessage } from "ai"
import { resolveCurrentSession } from "@/lib/session-user"
import {
  listNqaiThreads,
  loadNqaiThread,
  deleteNqaiThread,
  renameNqaiThread,
  moveNqaiThread,
  setNqaiThreadPinned,
  setNqaiThreadArchived,
  listNqaiFolders,
  createNqaiFolder,
  renameNqaiFolder,
  deleteNqaiFolder,
  moveNqaiFolder,
  type NqaiThreadSummary,
  type NqaiFolder,
} from "@/lib/nqai-chat-db"
import { getNqaiUserSnapshot } from "@/lib/nqai-user-context"
import { buildPersonalGreeting } from "@/lib/nqai-greeting"

export interface NqaiBootstrap {
  /**
   * Whether the history actually loaded. `false` means a transient failure
   * (no session yet, or a DB hiccup) — the client should RETRY rather than
   * render an empty "no conversations" state, which would look like data loss.
   */
  ok: boolean
  /** A personalized one-line briefing shown under the canonical welcome. */
  greeting: string
  /** The user's stored conversation threads (metadata for the history panel). */
  threads: NqaiThreadSummary[]
  /** The user's folders (the client assembles the nested tree from these). */
  folders: NqaiFolder[]
}

/** Combined folder tree + thread metadata for the organizer/sidebar. */
export interface NqaiOrganizer {
  /** False on a load failure (client should retry, not clobber existing data). */
  ok: boolean
  folders: NqaiFolder[]
  threads: NqaiThreadSummary[]
}

/**
 * Load everything the NQAi client needs on mount for the signed-in user. The
 * console ALWAYS opens clean (just the welcome) — so we return a personalized
 * greeting plus the list of past threads for the history panel, but never seed
 * the live transcript. The user explicitly opens a thread to continue it.
 */
export async function bootstrapNqai(): Promise<NqaiBootstrap> {
  try {
    const session = await resolveCurrentSession()
    // No session resolved (e.g. transient cookie/DB read). Signal not-ok so the
    // client retries instead of showing an empty, "lost history" state.
    if (!session) return { ok: false, greeting: "", threads: [], folders: [] }

    // The greeting is best-effort, but the thread/folder history is the whole
    // point of the panel — if EITHER of those throws, surface ok:false so the
    // client can retry rather than render an alarming empty history.
    const [threads, folders, snapshot] = await Promise.all([
      listNqaiThreads(session.id),
      listNqaiFolders(session.id),
      getNqaiUserSnapshot().catch(() => null),
    ])

    return {
      ok: true,
      greeting: buildPersonalGreeting(snapshot, threads.length > 0),
      threads,
      folders,
    }
  } catch {
    return { ok: false, greeting: "", threads: [], folders: [] }
  }
}

/** Re-fetch the signed-in user's thread list (for refreshing the history panel). */
export async function listNqaiThreadsAction(): Promise<NqaiThreadSummary[]> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return []
    return await listNqaiThreads(session.id)
  } catch {
    return []
  }
}

/** Load a single thread's transcript so the client can switch into it. */
export async function loadNqaiThreadAction(
  threadId: string,
): Promise<{ ok: boolean; messages: UIMessage[]; title: string }> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false, messages: [], title: "" }
    const thread = await loadNqaiThread(session.id, threadId)
    if (!thread) return { ok: false, messages: [], title: "" }
    return { ok: true, messages: thread.messages, title: thread.title }
  } catch {
    return { ok: false, messages: [], title: "" }
  }
}

/** Permanently delete one of the signed-in user's threads. */
export async function deleteNqaiThreadAction(threadId: string): Promise<{ ok: boolean }> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false }
    await deleteNqaiThread(session.id, threadId)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/** Rename one of the signed-in user's threads. */
export async function renameNqaiThreadAction(threadId: string, title: string): Promise<{ ok: boolean }> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false }
    await renameNqaiThread(session.id, threadId, title)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/** Pin or unpin one of the signed-in user's threads. */
export async function pinNqaiThreadAction(threadId: string, pinned: boolean): Promise<{ ok: boolean }> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false }
    await setNqaiThreadPinned(session.id, threadId, pinned)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/** Archive or unarchive one of the signed-in user's threads. */
export async function archiveNqaiThreadAction(threadId: string, archived: boolean): Promise<{ ok: boolean }> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false }
    await setNqaiThreadArchived(session.id, threadId, archived)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

// ---------------------------------------------------------------------------
// Folder organizer
// ---------------------------------------------------------------------------

/** Fetch the signed-in user's full folder tree + thread metadata together. */
export async function listNqaiOrganizerAction(): Promise<NqaiOrganizer> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false, folders: [], threads: [] }
    // Let a real DB error reject so we return ok:false — the client then keeps
    // whatever it already had instead of blanking the panel to empty.
    const [folders, threads] = await Promise.all([
      listNqaiFolders(session.id),
      listNqaiThreads(session.id),
    ])
    return { ok: true, folders, threads }
  } catch {
    return { ok: false, folders: [], threads: [] }
  }
}

/** Create a folder (optionally nested under parentId). Returns the new folder. */
export async function createNqaiFolderAction(
  name: string,
  parentId: string | null,
): Promise<{ ok: boolean; folder: NqaiFolder | null }> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false, folder: null }
    const folder = await createNqaiFolder(session.id, name, parentId ?? null)
    return { ok: Boolean(folder), folder }
  } catch {
    return { ok: false, folder: null }
  }
}

/** Rename one of the signed-in user's folders. */
export async function renameNqaiFolderAction(folderId: string, name: string): Promise<{ ok: boolean }> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false }
    await renameNqaiFolder(session.id, folderId, name)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/**
 * Delete a folder; its threads and subfolders are lifted to the deleted
 * folder's parent (never destroyed).
 */
export async function deleteNqaiFolderAction(folderId: string): Promise<{ ok: boolean }> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false }
    await deleteNqaiFolder(session.id, folderId)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/** Move a thread into a folder (folderId null = root / Unfiled). */
export async function moveNqaiThreadAction(threadId: string, folderId: string | null): Promise<{ ok: boolean }> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false }
    await moveNqaiThread(session.id, threadId, folderId ?? null)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/** Re-parent a folder (parentId null = root). Rejects cycles server-side. */
export async function moveNqaiFolderAction(
  folderId: string,
  parentId: string | null,
): Promise<{ ok: boolean }> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false }
    return await moveNqaiFolder(session.id, folderId, parentId ?? null)
  } catch {
    return { ok: false }
  }
}
