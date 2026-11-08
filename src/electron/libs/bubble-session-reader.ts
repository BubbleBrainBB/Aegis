import { extractSessionLinks } from '../../shared/session-links';
import { createNativeSessionReader, createNativeShowWidget, createNativeStartWorkflow, createNativeWidgetGuide } from './session-native-tool';
import { createBubbleBrowserUseTool, createBubbleIosSimulatorTool } from './bubble-browser-use-tool';
import { isIosSimulatorToolAvailableNow } from './ios-simulator/tool';
import { isBrowserUseEnabled } from './browser-use-permissions';
import { createNativeDesignTools } from '../design/tools';
import { createNativeReportStatus } from './turn-report-tool';
import { createNativeStartSession, createNativeTeamTools } from './follow-up/tool';
import { isTeamSession } from './team';
import type { BubbleContentPart } from './provider/bubble-sdk-loader';

export const BUBBLE_SESSION_TOOL = 'read_session';

/** Aegis host tools, passed to every Bubble turn (`runTurn({ hostTools })`).
 * The read-only conversation reader runs ungated, like builtin Read in Plan
 * mode; start_workflow and browser_use are actions, so Bubble gates them like
 * MCP tools. Host tools are turn-scoped, so a session's turns carry tools
 * bound to it. Bubble withholds host tools from subagents. */
export function bubbleHostTools(sessionId?: string): object[] {
  // The workflow entry (start_workflow); member sessions are refused at call time.
  const tools: object[] = [createNativeSessionReader(), createNativeStartWorkflow(), createNativeShowWidget(), createNativeWidgetGuide()];
  if (sessionId && isBrowserUseEnabled()) tools.push(createBubbleBrowserUseTool(sessionId));
  // On a Mac with Xcode and AXe: the iOS Simulator.
  if (sessionId && isBrowserUseEnabled() && isIosSimulatorToolAvailableNow()) tools.push(createBubbleIosSimulatorTool(sessionId));
  // Design tools act on this session's designs.
  if (sessionId) tools.push(...createNativeDesignTools(sessionId));
  if (sessionId) tools.push(createNativeReportStatus(sessionId));
  // Workflow members are refused at call time.
  if (sessionId) tools.push(createNativeStartSession(sessionId));
  if (sessionId && isTeamSession(sessionId)) tools.push(...createNativeTeamTools(sessionId));
  return tools;
}

export function assertBubbleSessionReader(prompt: string | BubbleContentPart[], tools: string[], currentSessionId: string): void {
  const text = typeof prompt === 'string' ? prompt : prompt.filter(part => part.type === 'text').map(part => part.text || '').join('\n');
  if (extractSessionLinks(text).some(link => link.sessionId !== currentSessionId) && !tools.includes(BUBBLE_SESSION_TOOL)) {
    throw new Error('Conversation reader is unavailable in this Bubble runtime. Restart Aegis, then retry this message.');
  }
}
