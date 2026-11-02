import { createContext } from 'react';
import { parseDesignLink } from '../../shared/design-links';
import type { DesignTurnChange } from './design-entries';

export interface DesignBoardLink {
  name: string;
  documentId: string;
  boardId: string;
}

/**
 * The boards a turn touched, as JSON for the markdown of its answer. A string
 * so that the context keeps its value when the turn's changes are recomputed.
 */
export const DesignBoardLinksContext = createContext('');

/** The chat a message is shown in, which may not be the active session (the Design dock, split panes). */
export const DesignLinkSessionContext = createContext<string | null>(null);

/** Touched boards that can be told apart by name: a name two boards share is left for the agent to link. */
export function designBoardLinksOf(changes: DesignTurnChange[]): DesignBoardLink[] {
  const owners = new Map<string, number>();
  for (const { names } of changes) {
    for (const name of Object.values(names)) owners.set(name, (owners.get(name) ?? 0) + 1);
  }
  return changes.flatMap(({ documentId, added, changed, names }) =>
    [...added, ...changed].flatMap((boardId) => {
      const name = names[boardId];
      return name && owners.get(name) === 1 ? [{ name, documentId, boardId }] : [];
    }),
  );
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

const ASCII_WORD = /[A-Za-z0-9_]/;

// "Home" is not in "Homepage"; Chinese text has no word breaks to look for.
function findName(text: string, name: string): number {
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    const before = text[at - 1] ?? '';
    const after = text[at + name.length] ?? '';
    const startsInWord = ASCII_WORD.test(name[0]) && ASCII_WORD.test(before);
    const endsInWord = ASCII_WORD.test(name[name.length - 1]) && ASCII_WORD.test(after);
    if (!startsInWord && !endsInWord) return at;
  }
  return -1;
}

function linkedBoards(node: MdNode, found: Set<string>) {
  const link = node.type === 'link' && node.url ? parseDesignLink(node.url) : null;
  if (link) found.add(link.boardId);
  node.children?.forEach((child) => linkedBoards(child, found));
}

/**
 * Remark plugin: the first mention of each board in an answer becomes a link
 * to it, unless the agent already linked that board. Works on text nodes, so
 * code and existing links stay as written.
 */
export function remarkDesignBoardLinks(boards: DesignBoardLink[]) {
  return (tree: MdNode) => {
    const linked = new Set<string>();
    linkedBoards(tree, linked);
    // One character is too easily part of ordinary text ("A board", 页).
    // Longest first: "Home · today" wins over "Home".
    const pending = boards
      .filter((board) => board.name.length > 1 && !linked.has(board.boardId))
      .sort((a, b) => b.name.length - a.name.length);

    const splitText = (value: string): MdNode[] => {
      let first: { board: DesignBoardLink; at: number } | null = null;
      for (const board of pending) {
        const at = findName(value, board.name);
        if (at >= 0 && (!first || at < first.at)) first = { board, at };
      }
      if (!first) return [{ type: 'text', value }];
      const { board, at } = first;
      pending.splice(pending.indexOf(board), 1);
      return [
        ...(at > 0 ? [{ type: 'text', value: value.slice(0, at) }] : []),
        {
          type: 'link',
          url: `aegis://designs/${board.documentId}/${board.boardId}`,
          children: [{ type: 'text', value: board.name }],
        },
        ...splitText(value.slice(at + board.name.length)),
      ];
    };
    const walk = (node: MdNode) => {
      if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
      node.children = node.children.flatMap((child) => {
        if (child.type === 'text' && child.value) return splitText(child.value);
        walk(child);
        return [child];
      });
    };
    walk(tree);
  };
}
