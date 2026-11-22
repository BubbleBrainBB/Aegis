// Computer use for Bubble: the gateway's ten tools as turn-scoped host tools,
// bound to their Aegis session by closure, like browser_use. Bubble has no
// MCP option of its own to carry them, and host tools hand screenshots to the
// model as images.
//
// Bubble treats the eight action tools as actions: it refuses them in Plan
// mode and asks its approval controller before each call. Aegis answers that
// request itself (see isBubbleComputerUseApproval): the gateway asks the user
// with the COMPUTER USE card, where the grants live, and asking twice would
// only teach people to click through.

import { computerUseGatewayTool, computerUseToolName } from '../../shared/computer-use';
import { getComputerUseGateway } from './computer-use';
import { COMPUTER_USE_TOOL_DEFINITIONS } from './computer-use/tools';

type BubbleImage = { mimeType: 'image/png' | 'image/jpeg'; data: string };

export function createBubbleComputerUseTools(sessionId: string): object[] {
  return COMPUTER_USE_TOOL_DEFINITIONS.map((definition) => ({
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
  }));
}

/**
 * Bubble's own approval request for a gateway tool. The gateway decides those
 * (lease, grant, approval card), so the adapter approves this layer without
 * showing a second card.
 */
export function isBubbleComputerUseApproval(request: { type?: unknown; title?: unknown }): boolean {
  return (
    request.type === 'external_tool' &&
    typeof request.title === 'string' &&
    computerUseGatewayTool(request.title) !== null
  );
}
