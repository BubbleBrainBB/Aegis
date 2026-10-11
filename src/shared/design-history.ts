import type { DesignDocument, DesignOperation } from "./design-types";

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
