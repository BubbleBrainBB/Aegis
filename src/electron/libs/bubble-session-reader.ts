import { extractSessionLinks } from '../../shared/session-links';
import { createNativeSessionReader, createNativeShowWidget, createNativeStartWorkflow, createNativeWidgetGuide } from './session-native-tool';
import { createBubbleBrowserUseTool, createBubbleIosSimulatorTool } from './bubble-browser-use-tool';
import { isIosSimulatorToolAvailableNow } from './ios-simulator/tool';
import { isBrowserUseEnabled } from './browser-use-permissions';
import { createBubbleComputerUseTools } from './bubble-computer-use-tool';
import { isComputerUseAvailableNow } from './computer-use';
import { getWorkflowSessionPolicy } from './workflow/session-hooks';
import { createNativeDesignTools } from '../design/tools';
import { createNativeReportStatus } from './turn-report-tool';
import { createNativeStartSession } from './follow-up/tool';
import { createMainBotTools, isMainBotSession, mainBotTurnOptions } from './main-bot/tools';
import type { BubbleContentPart } from './provider/bubble-sdk-loader';

export const BUBBLE_SESSION_TOOL = 'read_session';

/** Aegis host tools, passed to every Bubble turn (`runTurn({ hostTools })`).
 * The read-only conversation reader runs ungated, like builtin Read in Plan
 * mode; start_workflow and browser_use are actions, so Bubble gates them like
 * MCP tools. Host tools are turn-scoped, so a session's turns carry tools
 * bound to it. Bubble withholds host tools from subagents. */
export function bubbleHostTools(sessionId?: string): object[] {
  // The main bot hands work out instead of doing it: it reads conversations
  // and runs tasks, and has none of the tools that work inside one session.
  if (isMainBotSession(sessionId)) {
    return [createNativeSessionReader(), createNativeShowWidget(), createNativeWidgetGuide(), createNativeReportStatus(sessionId!), ...createMainBotTools()];
  }
  // The workflow entry (start_workflow); member sessions are refused at call time.
  const tools: object[] = [createNativeSessionReader(), createNativeStartWorkflow(), createNativeShowWidget(), createNativeWidgetGuide()];
  if (sessionId && isBrowserUseEnabled()) tools.push(createBubbleBrowserUseTool(sessionId));
  // On a Mac with Xcode and AXe: the iOS Simulator.
  if (sessionId && isBrowserUseEnabled() && isIosSimulatorToolAvailableNow()) tools.push(createBubbleIosSimulatorTool(sessionId));
  // Computer use, when its switch is on and the driver is there. A read-only
  // workflow member gets none (the gateway refuses it too).
  if (sessionId && isComputerUseAvailableNow() && !getWorkflowSessionPolicy(sessionId)?.readOnly) {
    tools.push(...createBubbleComputerUseTools(sessionId));
  }
  // Design tools act on this session's designs.
  if (sessionId) tools.push(...createNativeDesignTools(sessionId));
  if (sessionId) tools.push(createNativeReportStatus(sessionId));
  // Workflow members are refused at call time.
  if (sessionId) tools.push(createNativeStartSession(sessionId));
  return tools;
}

/**
 * A role of its own for a session's turns (`runTurn({ systemPrompt, allowedTools })`):
 * the main bot's. Every other session runs as the coding agent, with all of
 * its tools.
 */
export function bubbleRoleOptions(sessionId?: string): { systemPrompt?: string; allowedTools?: string[] } {
  return isMainBotSession(sessionId) ? mainBotTurnOptions() : {};
}

export function assertBubbleSessionReader(prompt: string | BubbleContentPart[], tools: string[], currentSessionId: string): void {
  const text = typeof prompt === 'string' ? prompt : prompt.filter(part => part.type === 'text').map(part => part.text || '').join('\n');
  if (extractSessionLinks(text).some(link => link.sessionId !== currentSessionId) && !tools.includes(BUBBLE_SESSION_TOOL)) {
    throw new Error('Conversation reader is unavailable in this Bubble runtime. Restart Aegis, then retry this message.');
  }
}
