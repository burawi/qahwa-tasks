import type { ChatMessage, MessagePage, MessagePageQuery, TaskWorkspace, WorkspaceUpdate } from "../domain/types";

/** Re-read only the range the reader has opened, in bounded keyset pages.
 * This also catches bursts larger than one page and edits in older loaded pages.
 */
export async function reconcileHistory(latest: TaskWorkspace, oldestCursor: string | null | undefined,
  page: (query: MessagePageQuery) => Promise<MessagePage>, current: () => boolean): Promise<TaskWorkspace | null> {
  let history = latest.history;
  const chunks = [latest.messages];
  if (latest.messages.length) while (oldestCursor && history?.hasOlder && history.oldestCursor && history.oldestCursor !== oldestCursor) {
    if (!current()) return null;
    const older = await page({ before: history.oldestCursor, through: oldestCursor });
    if (!current()) return null;
    if (!older.messages.length) break; // The boundary message may have been deleted.
    chunks.unshift(older.messages);
    history = { oldestCursor: older.oldestCursor, hasOlder: older.hasOlder };
  }
  return { ...latest, messages: chunks.flat(), ...(history ? { history } : {}) };
}

/** Mutation responses contain the latest page. Retain the reader's older pages. */
export function mergeWorkspaceTail(previous: TaskWorkspace | null, latest: TaskWorkspace): TaskWorkspace {
  if (!previous?.history || !latest.history || !previous.messages.length || !latest.messages.length) return mergeWorkspace(previous, latest);
  const overlap = previous.messages.findIndex(message => message.id === latest.messages[0]?.id);
  // A busy chat may have advanced by more than a page during the mutation.
  // Keep the contiguous saved range until the bounded refresh fills that gap.
  if (overlap < 0) return mergeWorkspace(previous, { ...latest, messages: previous.messages, history: previous.history });
  const prefix = previous.messages.slice(0, overlap);
  const end = previous.messages.findIndex(message => message.id === latest.messages.at(-1)?.id);
  const suffix = end >= overlap ? previous.messages.slice(end + 1) : [];
  const ids = new Set(latest.messages.map(message => message.id));
  return mergeWorkspace(previous, { ...latest, messages: [...prefix.filter(message => !ids.has(message.id)), ...latest.messages, ...suffix.filter(message => !ids.has(message.id))],
    history: prefix.length ? previous.history : latest.history });
}

function sameValue<T>(previous: T, next: T): T {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

/** Keep unchanged entries stable even when a poll appends or edits history. */
export function mergeWorkspace(previous: TaskWorkspace | null, update: WorkspaceUpdate): TaskWorkspace {
  if (!previous && !update.messages) throw new Error("Initial workspace is missing history");
  let messages = previous?.messages ?? update.messages!;
  if (previous && update.messages) {
    const byId = new Map(previous.messages.map((entry) => [entry.id, entry]));
    const next = update.messages.map((entry) => {
      const old = byId.get(entry.id);
      return old ? sameValue<ChatMessage>(old, entry) : entry;
    });
    if (next.length !== messages.length || next.some((entry, index) => entry !== messages[index])) messages = next;
  }
  const merged = { ...update, messages } as TaskWorkspace;
  if (!previous) return merged;
  for (const key of Object.keys(merged) as Array<keyof TaskWorkspace>) {
    // Each workspace section has its own identity so activity updates never invalidate history.
    (merged as unknown as Record<string, unknown>)[key] = key === "messages" ? messages : sameValue(previous[key], merged[key]);
  }
  return Object.keys(merged).every((key) => previous[key as keyof TaskWorkspace] === merged[key as keyof TaskWorkspace]) ? previous : merged;
}
