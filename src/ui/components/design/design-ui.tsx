import { createContext, useContext, useMemo } from "react";
import { useUserProfile } from "../../hooks/useUserProfile";
import {
  findDesignLayer,
  readDesignLayers,
} from "../../../shared/design-layers";
import type {
  DesignAnchor,
  DesignAuthor,
  DesignBoard,
} from "../../../shared/design-types";

export const initialOf = (name?: string) =>
  name?.trim()?.[0]?.toUpperCase() || "?";

/** The local user's display name; authors stored without one fall back to it. */
export function useDesignUser() {
  const profile = useUserProfile();
  return profile?.displayName || "You";
}

export function authorName(author: DesignAuthor | null | undefined, user: string) {
  if (!author) return "";
  return author.kind === "agent" ? author.name || "Agent" : author.name || user;
}

/** The agent of the conversation a design belongs to ("Claude Code"); set by the panel. */
export const DesignAgentName = createContext("Agent");
export const useDesignAgentName = () => useContext(DesignAgentName);

export function DesignAvatar({
  author,
  user,
  size = 20,
}: {
  author: DesignAuthor | null | undefined;
  user: string;
  size?: number;
}) {
  const agent = author?.kind === "agent";
  return (
    <span
      className={"design-avatar" + (agent ? " is-agent" : "")}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
      aria-hidden
    >
      {initialOf(authorName(author, user))}
    </span>
  );
}

export function relativeTime(at: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(at).toLocaleDateString();
}

/** Layer display name for an anchor, from the board's current HTML. */
export function useLayerName(board: DesignBoard | undefined, nodeId?: string) {
  return useMemo(
    () => layerName(board, nodeId),
    [board?.html, nodeId],
  );
}
export function layerName(board: DesignBoard | undefined, nodeId?: string) {
  if (!board || !nodeId) return undefined;
  return findDesignLayer(readDesignLayers(board.html), nodeId)?.name;
}

export const errorText = (e: unknown) =>
  e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, "")
    : String(e);

/** "Area · 4 layers" for area comments, else the layer's name. */
export function anchorLabel(board: DesignBoard | undefined, anchor: DesignAnchor) {
  if (anchor.area) {
    const n = anchor.nodeIds?.length ?? 0;
    return `Area · ${n} layer${n === 1 ? "" : "s"}`;
  }
  return layerName(board, anchor.nodeId);
}

/** Crops a board screenshot to a board-space rect (plus a margin) as PNG bytes. */
export async function cropBoardImage(
  dataUrl: string,
  boardWidth: number,
  rect: { x: number; y: number; width: number; height: number },
  margin = 24,
): Promise<Uint8Array | undefined> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const scale = img.naturalWidth / boardWidth;
  const x = Math.max(0, (rect.x - margin) * scale);
  const y = Math.max(0, (rect.y - margin) * scale);
  const w = Math.min(img.naturalWidth - x, (rect.width + margin * 2) * scale);
  const h = Math.min(img.naturalHeight - y, (rect.height + margin * 2) * scale);
  if (w < 2 || h < 2) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w);
  canvas.height = Math.round(h);
  canvas.getContext("2d")!.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
}
