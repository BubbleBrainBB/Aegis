import type { DesignDocument, DesignOperation, DesignRevisionInfo } from "./design-types";

/** Fallback one-line history summary when the writer supplied none. */
export function summarizeOperations(
  ops: DesignOperation[],
  before: Pick<DesignDocument, "boards" | "title">,
): string {
  const name = (boardId: string) =>
    before.boards.find((b) => b.id === boardId)?.name ?? "board";
  const lines = ops.map((op) => {
    switch (op.type) {
      case "add":
        return `Added ${op.name}`;
      case "content":
        return `Edited ${name(op.boardId)}`;
      case "remove":
        return `Deleted ${name(op.boardId)}`;
      case "duplicate":
        return `Duplicated ${name(op.boardId)}`;
      case "title":
        return `Renamed design to ${op.title}`;
      case "placement": {
        const old = name(op.boardId);
        if (op.name !== undefined && op.name !== old)
          return `Renamed ${old} to ${op.name}`;
        if (op.width !== undefined || op.height !== undefined)
          return `Resized ${old}`;
        return `Moved ${old}`;
      }
    }
  });
  // Group moves keep history readable: "Moved Home, Journal".
  const unique = [...new Set(lines)];
  if (unique.every((l) => l.startsWith("Moved ")) && unique.length > 1)
    return trim(`Moved ${unique.map((l) => l.slice(6)).join(", ")}`);
  const head = unique.slice(0, 2).join(" · ");
  return trim(unique.length > 2 ? `${head} and ${unique.length - 2} more` : head);
}

const trim = (s: string) => (s.length > 160 ? `${s.slice(0, 159)}…` : s);

/** One version as the user thinks of it: a request answered, a stretch of hand edits, or a restore. */
export interface DesignVersionGroup {
  /** "request": every save answering one message; "edits": hand edits close together; "restore": going back. */
  kind: "request" | "edits" | "restore" | "agent";
  /** The saves inside it, newest first. */
  revisions: DesignRevisionInfo[];
  /** The newest save: viewing or restoring the version means this one. */
  last: number;
  /** The oldest save in it. */
  first: number;
  title: string;
  author: DesignRevisionInfo["author"];
  createdAt: number;
  boardIds: string[];
}

/** Hand edits further apart than this start a new version. */
export const EDIT_SESSION_GAP_MS = 5 * 60_000;
/** Agent saves without a recorded request: one version while they keep coming. */
const AGENT_RUN_GAP_MS = 3 * 60_000;

const isRestore = (v: DesignRevisionInfo) => v.author?.kind === "user" && /^Restored\b/.test(v.summary ?? "");
const quoteless = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Saves (newest first, as history lists them) folded into versions: one per
 * request, one per stretch of hand edits, one per restore. Each version only
 * holds consecutive saves, so restoring it is restoring its newest save.
 */
export function groupDesignVersions(versions: DesignRevisionInfo[]): DesignVersionGroup[] {
  const ascending = [...versions].sort((a, b) => a.revision - b.revision);
  const groups: DesignVersionGroup[] = [];
  const keyOf = (v: DesignRevisionInfo) =>
    isRestore(v)
      ? `restore:${v.revision}`
      : v.author?.kind === "agent"
        ? v.requestId
          ? `request:${v.requestId}`
          : `agent:${v.author.name}`
        : "edits";
  let key = "";
  let lastAt = 0;
  for (const v of ascending) {
    const next = keyOf(v);
    const gap = v.createdAt - lastAt;
    const joins =
      groups.length > 0 &&
      next === key &&
      (next.startsWith("request:") ||
        (next === "edits" && gap <= EDIT_SESSION_GAP_MS) ||
        (next.startsWith("agent:") && gap <= AGENT_RUN_GAP_MS));
    if (joins) {
      const group = groups[groups.length - 1];
      group.revisions.unshift(v);
      group.last = v.revision;
      group.createdAt = v.createdAt;
      for (const id of v.boardIds) if (!group.boardIds.includes(id)) group.boardIds.push(id);
    } else {
      groups.push({
        kind: next.startsWith("request:") ? "request" : next.startsWith("restore:") ? "restore" : next === "edits" ? "edits" : "agent",
        revisions: [v],
        first: v.revision,
        last: v.revision,
        title: "",
        author: v.author,
        createdAt: v.createdAt,
        boardIds: [...v.boardIds],
      });
    }
    key = next;
    lastAt = v.createdAt;
  }
  for (const group of groups) group.title = versionTitle(group);
  return groups.reverse();
}

function versionTitle(group: DesignVersionGroup): string {
  const newest = group.revisions[0];
  if (group.kind === "request") {
    const prompt = group.revisions.find((r) => r.prompt)?.prompt;
    return prompt ? trim(quoteless(prompt)) : newest.summary || "Agent changes";
  }
  if (group.kind === "restore") return newest.summary || "Restored an earlier version";
  if (group.revisions.length === 1) return newest.summary || (group.kind === "edits" ? "Edited by hand" : "Agent changes");
  return group.kind === "edits" ? `Edited by hand · ${group.revisions.length} changes` : `${newest.summary || "Agent changes"} and more`;
}
