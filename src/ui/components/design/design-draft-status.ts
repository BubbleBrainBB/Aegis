import { useAppStore } from "../../store/useAppStore";
import { designToolDisplay } from "../../utils/design-tool-display";
import { designToolNameOf } from "../../../shared/design-tools";
import type { StreamMessage } from "../../../shared/types";

type Block = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string };
const blocksOf = (message: StreamMessage): Block[] => {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
};

/**
 * What the design's agent is doing right now, in a few words ("Drawing
 * Pricing"): the latest design call still waiting for its result.
 */
export function designRunStatus(messages: StreamMessage[]): string | null {
  const answered = new Set<string>();
  for (let i = messages.length - 1, seen = 0; i >= 0 && seen < 60; i--, seen++) {
    const message = messages[i];
    if (message.type === "user") {
      for (const block of blocksOf(message)) if (block.type === "tool_result" && block.tool_use_id) answered.add(block.tool_use_id);
      continue;
    }
    if (message.type !== "assistant") continue;
    const blocks = blocksOf(message);
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j];
      if (block.type !== "tool_use" || !block.id || answered.has(block.id)) continue;
      if (!designToolNameOf(block.name)) return null;
      const display = designToolDisplay(block.name!, block.input, "pending");
      return display ? `${display.verb} ${display.target}`.trim() : null;
    }
  }
  return null;
}

export function useDesignDraftStatus(sessionId: string, running: boolean): string | null {
  return useAppStore((s) => (running ? designRunStatus(s.sessions[sessionId]?.messages ?? []) : null));
}
