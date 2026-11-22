import { EventEmitter } from 'events';
import {
  AEGIS_COMPUTER_USE_SERVER_NAME,
  canonicalizeComputerUseApp,
  computerUseRiskRank,
  isComputerUseMutatingTool,
  isComputerUseServerName,
  isDeniedComputerUseTarget,
  type ComputerUseGrantView,
} from '../../shared/computer-use';
import type { McpToolApprovalElicitation } from './codex-computer-use-elicitation';

export interface ComputerUseGrant extends ComputerUseGrantView {}

/** What a grant covers, whichever backend asked for it. */
export interface ComputerUseGrantTarget {
  threadId: string;
  /** The provider's own thread, where one session holds several (Codex subagents); null otherwise. */
  providerThreadId: string | null;
  /** The runtime the grant belongs to: a grant from a replaced runtime no longer matches. */
  generation: number;
  server: string | null;
  tool: string | null;
  app: string | null;
  riskLevel: string | null;
}

function grantTargetFromElicitation(input: {
  threadId: string;
  generation: number;
  elicitation: McpToolApprovalElicitation;
}): ComputerUseGrantTarget {
  return {
    threadId: input.threadId,
    providerThreadId: input.elicitation.providerThreadId,
    generation: input.generation,
    server: input.elicitation.server,
    tool: input.elicitation.toolName,
    app: input.elicitation.canonicalApp,
    riskLevel: input.elicitation.riskLevel,
  };
}

function grantKey(input: {
  threadId: string;
  providerThreadId: string | null;
  server: string;
  tool: string;
  app: string;
}): string {
  return [
    input.threadId,
    input.providerThreadId || '',
    input.server.trim().toLowerCase(),
    input.tool.trim().toLowerCase(),
    input.app.trim().toLowerCase(),
  ].join('\0');
}

export class ComputerUseGrantRegistry extends EventEmitter {
  private grants = new Map<string, ComputerUseGrant>();

  list(threadId?: string): ComputerUseGrantView[] {
    const values = [...this.grants.values()];
    return threadId ? values.filter((grant) => grant.threadId === threadId) : values;
  }

  emitChange(threadId: string, reason: string): void {
    this.emit('change', { threadId, grants: this.list(threadId), reason });
  }

  isCreatable(elicitation: McpToolApprovalElicitation): boolean {
    return elicitation.grantEligible;
  }

  /**
   * Grant one (session, server, tool, app) target up to a risk level. Any
   * backend uses this: Codex converts its elicitation, the Computer use
   * gateway passes what it resolved itself.
   */
  createGrant(target: ComputerUseGrantTarget): ComputerUseGrantView | null {
    const app = canonicalizeComputerUseApp(target.app);
    const tool = target.tool?.trim() || null;
    const server = target.server?.trim() || null;
    if (!app || !tool || !server) return null;
    const grant: ComputerUseGrant = {
      key: grantKey({
        threadId: target.threadId,
        providerThreadId: target.providerThreadId,
        server,
        tool,
        app,
      }),
      threadId: target.threadId,
      providerThreadId: target.providerThreadId,
      generation: target.generation,
      server,
      tool,
      app,
      maxRisk: computerUseRiskRank(target.riskLevel),
      createdAt: Date.now(),
    };
    this.grants.set(grant.key, grant);
    this.emitChange(target.threadId, 'granted');
    return grant;
  }

  /** The grant that covers this target, if one does. */
  matchGrant(target: ComputerUseGrantTarget): ComputerUseGrantView | null {
    const app = canonicalizeComputerUseApp(target.app);
    const tool = target.tool?.trim() || null;
    const server = target.server?.trim() || null;
    if (!app || !tool || !server) return null;
    const key = grantKey({
      threadId: target.threadId,
      providerThreadId: target.providerThreadId,
      server,
      tool,
      app,
    });
    const grant = this.grants.get(key);
    if (!grant) return null;
    if (grant.generation !== target.generation) return null;
    if (computerUseRiskRank(target.riskLevel) > grant.maxRisk) return null;
    return grant;
  }

  createFromElicitation(input: {
    threadId: string;
    generation: number;
    elicitation: McpToolApprovalElicitation;
  }): ComputerUseGrantView | null {
    if (!this.isCreatable(input.elicitation)) return null;
    return this.createGrant(grantTargetFromElicitation(input));
  }

  match(input: {
    threadId: string;
    generation: number;
    elicitation: McpToolApprovalElicitation;
  }): ComputerUseGrantView | null {
    if (!input.elicitation.grantEligible) return null;
    return this.matchGrant(grantTargetFromElicitation(input));
  }

  revoke(threadId: string, key?: string): ComputerUseGrantView[] {
    if (key) {
      const grant = this.grants.get(key);
      if (!grant || grant.threadId !== threadId) return this.list(threadId);
      this.grants.delete(key);
      this.emitChange(threadId, 'revoked');
      return this.list(threadId);
    }
    return this.revokeThread(threadId);
  }

  revokeThread(threadId: string, reason = 'revoked'): ComputerUseGrantView[] {
    let changed = false;
    for (const [key, grant] of this.grants) {
      if (grant.threadId === threadId) {
        this.grants.delete(key);
        changed = true;
      }
    }
    if (changed) this.emitChange(threadId, reason);
    return [];
  }

  revokeAll(reason = 'revoked'): void {
    const threadIds = new Set([...this.grants.values()].map((grant) => grant.threadId));
    this.grants.clear();
    for (const threadId of threadIds) {
      this.emitChange(threadId, reason);
    }
  }
}

export const computerUseGrants = new ComputerUseGrantRegistry();
computerUseGrants.setMaxListeners(50);

export function isStructuredComputerUseGrantTarget(
  elicitation: Pick<McpToolApprovalElicitation, 'server' | 'toolName' | 'isNodeRepl' | 'canonicalApp'>
): boolean {
  return (
    isComputerUseServerName(elicitation.server) &&
    elicitation.server === AEGIS_COMPUTER_USE_SERVER_NAME &&
    Boolean(elicitation.toolName && isComputerUseMutatingTool(elicitation.toolName)) &&
    !elicitation.isNodeRepl &&
    Boolean(canonicalizeComputerUseApp(elicitation.canonicalApp)) &&
    !isDeniedComputerUseTarget(elicitation.canonicalApp)
  );
}
