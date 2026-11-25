// Computer use for Bubble: the gateway's tools as turn-scoped host tools,
// bound to their Aegis session by closure, like browser_use. Bubble has no
// MCP option of its own to carry them, and host tools hand screenshots to the
// model as images.
//
// Bubble treats the mutating tools as actions: it refuses them in Plan
// mode and asks its approval controller before each call. Aegis answers that
// request itself, but only for a turn these tools were really registered in
// (see bubbleComputerUseToolNames): the gateway asks the user with the
// COMPUTER USE card, where the grants live, and asking twice would only
// teach people to click through.

import { computerUseToolName } from '../../shared/computer-use';
import { getComputerUseGateway } from './computer-use';
import { COMPUTER_USE_TOOL_DEFINITIONS } from './computer-use/tools';

type BubbleImage = { mimeType: 'image/png' | 'image/jpeg'; data: string };

/** The tool objects this module made, so a turn's host tools can be told from anything that only shares a name. */
const gatewayTools = new WeakSet<object>();

export function createBubbleComputerUseTools(sessionId: string): object[] {
  return COMPUTER_USE_TOOL_DEFINITIONS.map((definition) => {
    const tool = {
      // The MCP-style name: approval rules, the transcript's "Computer use"
      // labels and the HUD all read the server and tool out of it.
      name: computerUseToolName(definition.name),
      description: definition.description,
      parameters: definition.parameters,
      readOnly: !definition.mutating,
      effect: 'unknown' as const,
      requiresApproval: definition.mutating,
      async execute(args: Record<string, unknown>, ctx?: { abortSignal?: AbortSignal; toolCall?: { id?: string } }) {
        const gateway = getComputerUseGateway();
        if (!gateway) return { content: 'Computer use is not available in this app.', isError: true };
        const result = await gateway.call({
          sessionId,
          tool: definition.name,
          args: args && typeof args === 'object' ? args : {},
          toolUseId: ctx?.toolCall?.id || `computer-use-${Date.now().toString(36)}`,
          signal: ctx?.abortSignal,
        });
        const images: BubbleImage[] = result.images.map((image) => ({
          mimeType: image.mimeType.includes('png') ? 'image/png' : 'image/jpeg',
          data: image.data,
        }));
        return { content: result.text, ...(images.length ? { images } : {}), isError: result.isError };
      },
    };
    gatewayTools.add(tool);
    return tool;
  });
}

/**
 * The names of the gateway tools among the host tools a turn is given. Empty
 * when the switch is off, the driver is missing, or the session gets none.
 */
export function bubbleComputerUseToolNames(hostTools: readonly object[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const tool of hostTools) {
    if (gatewayTools.has(tool)) names.add((tool as { name: string }).name);
  }
  return names;
}

/**
 * Bubble's own approval request for a gateway tool of this turn. The gateway
 * decides those (lease, grant, approval card), so the adapter approves this
 * layer without showing a second card.
 *
 * `registered` is what the turn was really given. A host tool shadows an MCP
 * tool of the same name only in a turn it is registered in; in any other
 * turn the same name is somebody's MCP server, its call never reaches the
 * gateway, and it gets Bubble's ordinary approval.
 */
export function isBubbleComputerUseApproval(
  request: { type?: unknown; title?: unknown },
  registered: ReadonlySet<string>
): boolean {
  return request.type === 'external_tool' && typeof request.title === 'string' && registered.has(request.title);
}
