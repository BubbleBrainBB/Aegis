import {
  DESIGN_COMMENTS_TOOL, DESIGN_CREATE_TOOL, DESIGN_GUIDE_TOOL, DESIGN_PREVIEW_TOOL, DESIGN_READ_TOOL,
  DESIGN_REPLY_TOOL, DESIGN_RESOURCES_TOOL, DESIGN_STARTER_TOOL, DESIGN_SYSTEM_CHECK_TOOL, DESIGN_UPDATE_TOOL, DESIGN_VERIFY_TOOL, designToolNameOf,
} from '../../shared/design-tools';
import type { ToolStatus } from '../types';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : '');
const STARTER_LABELS: Record<string, string> = {
  'ios-phone': 'iOS phone', 'android-phone': 'Android phone', 'browser-window': 'browser window', 'macos-window': 'macOS window',
};

/** What a design operation did, in the user's words ("Added Pricing", "Edited 2 boards"). */
function describeOperations(operations: unknown): string {
  if (!Array.isArray(operations) || operations.length === 0) return 'the design';
  const ops = operations.map(record);
  const added = ops.filter((op) => op.type === 'add').map((op) => text(op.name)).filter(Boolean);
  if (added.length === ops.length) return added.length === 1 ? added[0] : `${added.length} boards`;
  const boards = new Set(ops.map((op) => text(op.boardId) || text(op.name)).filter(Boolean));
  return boards.size === 1 ? 'a board' : `${boards.size || ops.length} boards`;
}

/** Trace row wording for the design tools; null for any other tool. */
export function designToolDisplay(name: string, input: unknown, status: ToolStatus): { verb: string; target: string } | null {
  const tool = designToolNameOf(name);
  if (!tool) return null;
  const pending = status === 'pending';
  const args = record(input);
  switch (tool) {
    case DESIGN_CREATE_TOOL:
      return { verb: pending ? 'Creating design' : 'Created design', target: text(args.title) || 'a design' };
    case DESIGN_UPDATE_TOOL: {
      const summary = text(args.summary);
      if (summary) return { verb: '', target: summary };
      const ops = Array.isArray(args.operations) ? args.operations.map(record) : [];
      const adding = ops.length > 0 && ops.every((op) => op.type === 'add');
      return {
        verb: adding ? (pending ? 'Drawing' : 'Drew') : pending ? 'Editing' : 'Edited',
        target: describeOperations(args.operations),
      };
    }
    case DESIGN_PREVIEW_TOOL:
      return { verb: pending ? 'Checking' : 'Checked', target: 'the board preview' };
    case DESIGN_READ_TOOL:
      return { verb: pending ? 'Reading' : 'Read', target: args.documentId ? 'the design' : 'this conversation’s designs' };
    case DESIGN_COMMENTS_TOOL:
      return { verb: pending ? 'Reading' : 'Read', target: 'design comments' };
    case DESIGN_REPLY_TOOL:
      return { verb: pending ? 'Replying' : 'Replied', target: 'to a design comment' };
    case DESIGN_GUIDE_TOOL:
      return { verb: pending ? 'Reading' : 'Read', target: 'the design guide' };
    case DESIGN_RESOURCES_TOOL:
      return {
        verb: pending ? 'Reading' : 'Read',
        target: args.name ? `the ${text(args.kind) || 'design system'} ${text(args.name)}` : 'the design system',
      };
    case DESIGN_STARTER_TOOL:
      return { verb: pending ? 'Getting' : 'Got', target: `the ${STARTER_LABELS[text(args.kind)] ?? 'device'} frame` };
    case DESIGN_SYSTEM_CHECK_TOOL:
      return { verb: pending ? 'Checking' : 'Checked', target: 'the design system' };
    case DESIGN_VERIFY_TOOL:
      return { verb: pending ? 'Verifying' : 'Verified', target: 'the design' };
  }
}
