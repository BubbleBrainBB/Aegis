/** Agent tools that read and write design canvases (src/electron/design/tools.ts). */
export const DESIGN_CREATE_TOOL = 'design_create';
export const DESIGN_READ_TOOL = 'design_read';
export const DESIGN_UPDATE_TOOL = 'design_update';
export const DESIGN_PREVIEW_TOOL = 'design_preview';
export const DESIGN_COMMENTS_TOOL = 'design_comments';
export const DESIGN_REPLY_TOOL = 'design_reply';
export const DESIGN_GUIDE_TOOL = 'design_guide';
export const DESIGN_RESOURCES_TOOL = 'design_resources';
export const DESIGN_STARTER_TOOL = 'design_starter';
export const DESIGN_SYSTEM_CHECK_TOOL = 'design_system_check';

export const DESIGN_TOOL_NAMES = [
  DESIGN_CREATE_TOOL,
  DESIGN_READ_TOOL,
  DESIGN_UPDATE_TOOL,
  DESIGN_PREVIEW_TOOL,
  DESIGN_COMMENTS_TOOL,
  DESIGN_REPLY_TOOL,
  DESIGN_GUIDE_TOOL,
  DESIGN_RESOURCES_TOOL,
  DESIGN_STARTER_TOOL,
  DESIGN_SYSTEM_CHECK_TOOL,
] as const;
export type DesignToolName = (typeof DESIGN_TOOL_NAMES)[number];

/**
 * The bare design tool a provider's tool name refers to: bare, or namespaced
 * by one of Aegis's own MCP servers (`mcp__aegis-sessions__design_update`,
 * `aegis-widgets_design_update`). Another server's look-alike is not ours.
 */
export function designToolNameOf(name: unknown): DesignToolName | null {
  if (typeof name !== 'string') return null;
  const normalized = name.trim().toLowerCase();
  for (const tool of DESIGN_TOOL_NAMES) {
    if (normalized === tool) return tool;
    if (!normalized.endsWith(tool)) continue;
    const prefix = normalized.slice(0, -tool.length);
    if (/^(?:mcp__)?aegis-[a-z]+(?:__|[_./:])$/.test(prefix)) return tool;
  }
  return null;
}

/** Tools that change a design (the canvas shows their result). */
export function isDesignWriteTool(name: unknown): boolean {
  const tool = designToolNameOf(name);
  return tool === DESIGN_CREATE_TOOL || tool === DESIGN_UPDATE_TOOL;
}
