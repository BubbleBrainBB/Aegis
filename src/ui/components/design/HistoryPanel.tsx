import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, X } from "../icons";
import { DesignAvatar, authorName, relativeTime } from "./design-ui";
import { groupDesignVersions, type DesignVersionGroup } from "../../../shared/design-history";
import type { DesignRevisionInfo } from "../../../shared/design-types";

/**
 * Version history, one row per version as the user thinks of it: a request
 * the agent answered, a stretch of hand edits, or a restore. Each opens to
 * the individual saves inside it. Selecting shows it read-only; restoring
 * makes a new version.
 */
export function HistoryPanel({
  versions,
  head,
  selected,
  user,
  editable,
  busy,
  boardName,
  onSelect,
  onRestore,
  onCompare,
  onClose,
}: {
  versions: DesignRevisionInfo[];
  head: number;
  selected?: number;
  user: string;
  editable: boolean;
  busy: boolean;
  boardName(id: string): string | undefined;
  onSelect(revision?: number): void;
  onRestore(revision: number, boardId?: string): void;
  onCompare(from: number, to: number, boardId?: string): void;
  onClose(): void;
}) {
  const groups = useMemo(() => groupDesignVersions(versions), [versions]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (last: number) =>
    setOpen((old) => {
      const next = new Set(old);
      if (next.has(last)) next.delete(last);
      else next.add(last);
      return next;
    });
  const viewing = selected ?? head;

  return (
    <aside className="design-history" aria-label="Version history">
      <header>
        <strong>History</strong>
        <span>
          {groups.length} version{groups.length === 1 ? "" : "s"}
        </span>
        <span className="design-spacer" />
        <button className="design-icon-button" aria-label="Close history" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className="design-history-list" role="listbox" aria-label="Versions">
        {groups.map((group, i) => {
          const isHead = group.last === head;
          const contains = group.revisions.some((r) => r.revision === viewing);
          const active = contains;
          // The state before this version: the previous version's newest save.
          const before = groups[i + 1]?.last;
          const expanded = open.has(group.last);
          const named = group.boardIds.map((id) => [id, boardName(id)] as const).filter(([, n]) => n);
          return (
            <div key={group.last} className="design-version-group" data-version-kind={group.kind} data-revision={group.last}>
              <div
                role="option"
                aria-selected={active}
                className={"design-version" + (active ? " is-active" : "")}
                data-revision={group.last}
                onClick={() => onSelect(isHead ? undefined : group.last)}
              >
                <DesignAvatar author={group.author ?? { kind: "user" }} user={user} />
                <div className="design-version-body">
                  <div className="design-version-head">
                    <strong className="design-version-title" title={group.title}>
                      {group.kind === "request" ? `“${group.title}”` : group.title}
                    </strong>
                  </div>
                  <span className="design-version-meta">
                    {authorName(group.author, user)} · {relativeTime(group.createdAt)}
                    {isHead ? " · Latest" : ""}
                  </span>
                  {active && (
                    <div className="design-version-actions" onClick={(e) => e.stopPropagation()}>
                      {!isHead && (
                        <button disabled={!editable || busy} onClick={() => onRestore(group.last)}>
                          Restore this version
                        </button>
                      )}
                      {!isHead &&
                        named.slice(0, 2).map(([id, name]) => (
                          <button key={id} disabled={!editable || busy} onClick={() => onRestore(group.last, id)}>
                            Restore {name} only
                          </button>
                        ))}
                      {before !== undefined && named.length > 0 && (
                        <button onClick={() => onCompare(before, group.last, named[0][0])}>Compare</button>
                      )}
                    </div>
                  )}
                  {group.revisions.length > 1 && (
                    <button
                      className="design-version-saves"
                      aria-expanded={expanded}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(group.last);
                      }}
                    >
                      {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      {group.revisions.length} saves
                    </button>
                  )}
                </div>
              </div>
              {expanded && <SaveList group={group} {...{ head, viewing, editable, busy, onSelect, onRestore }} />}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/** The individual saves inside one version, for going back to a finer step. */
function SaveList({
  group,
  head,
  viewing,
  editable,
  busy,
  onSelect,
  onRestore,
}: {
  group: DesignVersionGroup;
  head: number;
  viewing: number;
  editable: boolean;
  busy: boolean;
  onSelect(revision?: number): void;
  onRestore(revision: number): void;
}) {
  return (
    <div className="design-version-steps" role="group" aria-label="Saves in this version">
      {group.revisions.map((save) => {
        const isHead = save.revision === head;
        const active = save.revision === viewing;
        return (
          <div
            key={save.revision}
            role="option"
            aria-selected={active}
            className={"design-version-step" + (active ? " is-active" : "")}
            data-step-revision={save.revision}
            onClick={() => onSelect(isHead ? undefined : save.revision)}
          >
            <span className="design-version-step-text">{save.summary || "Saved"}</span>
            <span className="design-version-step-time">{relativeTime(save.createdAt)}</span>
            {active && !isHead && (
              <button
                disabled={!editable || busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onRestore(save.revision);
                }}
              >
                Restore
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
