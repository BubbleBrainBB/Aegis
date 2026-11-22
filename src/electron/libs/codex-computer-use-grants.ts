import { EventEmitter } from 'events';
import {
  AEGIS_COMPUTER_USE_SERVER_NAME,
  canonicalizeComputerUseApp,
  computerUseRiskRank,
  isComputerUseMutatingTool,
  isComputerUseServerName,
  isDeniedComputerUseTarget,
  type ComputerUseGrantOwner,
  type ComputerUseGrantView,
} from '../../shared/computer-use';
import type { McpToolApprovalElicitation } from './codex-computer-use-elicitation';

export interface ComputerUseGrant extends ComputerUseGrantView {}

/** What a grant covers, whichever backend asked for it. */
export interface ComputerUseGrantTarget {
  /** The backend the grant is for; one backend's grants never answer for the other's calls. */
  owner: ComputerUseGrantOwner;
  threadId: string;
  /** The provider's own thread, where one session holds several (Codex subagents); null otherwise. */
  providerThreadId: string | null;
  /** The runtime the grant belongs to: a grant from a replaced runtime no longer matches. */
  generation: number;
  server: string | null;
  tool: string | null;
  /** The app's name, shown on the card and in the grant list. */
  app: string | null;
  /**
   * The app's exact identity (its bundle identifier) when the backend knows
   * it. Two apps can share a name; with an id the grant is matched on the id
   * and the name is only shown.
   */
  appId?: string | null;
  riskLevel: string | null;
}

function grantTargetFromElicitation(input: {
  threadId: string;
  generation: number;
  elicitation: McpToolApprovalElicitation;
}): ComputerUseGrantTarget {
  return {
    owner: 'codex',
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
  owner: ComputerUseGrantOwner;
  threadId: string;
  providerThreadId: string | null;
  server: string;
  tool: string;
  app: string;
  appId?: string | null;
}): string {
  const identity = input.appId?.trim();
  return [
    // Codex keys keep the shape they had before backends were told apart.
    ...(input.owner === 'codex' ? [] : [input.owner]),
    input.threadId,
    input.providerThreadId || '',
    input.server.trim().toLowerCase(),
    input.tool.trim().toLowerCase(),
    // An identity and a name never collide: `id:` cannot start an app name key.
    identity ? `id:${identity.toLowerCase()}` : input.app.trim().toLowerCase(),
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
    const appId = target.appId?.trim() || undefined;
    const grant: ComputerUseGrant = {
      key: grantKey({ ...target, server, tool, app, appId }),
      threadId: target.threadId,
      providerThreadId: target.providerThreadId,
      generation: target.generation,
      server,
      tool,
      app,
      ...(appId ? { appId } : {}),
      owner: target.owner,
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
    const grant = this.grants.get(grantKey({ ...target, server, tool, app }));
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

  /** Ends a session's grants; with an owner, only that backend's. */
  revokeThread(threadId: string, reason = 'revoked', owner?: ComputerUseGrantOwner): ComputerUseGrantView[] {
    let changed = false;
    for (const [key, grant] of this.grants) {
      if (grant.threadId === threadId && (!owner || grantOwner(grant) === owner)) {
        this.grants.delete(key);
        changed = true;
      }
    }
    if (changed) this.emitChange(threadId, reason);
    return this.list(threadId);
  }

  /**
   * Ends a session's grants of one backend that belong to an earlier runtime.
   * They no longer match anything; this takes them out of the list as well.
   */
  revokeOtherGenerations(threadId: string, generation: number, owner: ComputerUseGrantOwner, reason = 'runtime-replaced'): void {
    let changed = false;
    for (const [key, grant] of this.grants) {
      if (grant.threadId !== threadId || grantOwner(grant) !== owner || grant.generation === generation) continue;
      this.grants.delete(key);
      changed = true;
    }
    if (changed) this.emitChange(threadId, reason);
  }

  /** Ends every grant of one backend, in every session, and leaves the other backend's alone. */
  revokeOwner(owner: ComputerUseGrantOwner, reason = 'revoked'): void {
    const threadIds = new Set<string>();
    for (const [key, grant] of this.grants) {
      if (grantOwner(grant) !== owner) continue;
      this.grants.delete(key);
      threadIds.add(grant.threadId);
    }
    for (const threadId of threadIds) {
      this.emitChange(threadId, reason);
    }
  }

  /** Ends every grant of every backend. For tests and a full reset; a backend shutting down uses revokeOwner. */
  revokeAll(reason = 'revoked'): void {
    const threadIds = new Set([...this.grants.values()].map((grant) => grant.threadId));
    this.grants.clear();
    for (const threadId of threadIds) {
      this.emitChange(threadId, reason);
    }
  }
}

function grantOwner(grant: ComputerUseGrantView): ComputerUseGrantOwner {
  return grant.owner ?? 'codex';
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
