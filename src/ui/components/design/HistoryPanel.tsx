import { X } from "../icons";
import { DesignAvatar, relativeTime } from "./design-ui";
import type { DesignRevisionInfo } from "../../../shared/design-types";

/** Version list. Selecting a row shows it read-only; restoring is a new version. */
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
  return (
    <aside className="design-history" aria-label="Version history">
      <header>
        <strong>History</strong>
        <span>
          {versions.length} version{versions.length === 1 ? "" : "s"}
        </span>
        <span className="design-spacer" />
        <button className="design-icon-button" aria-label="Close history" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className="design-history-list" role="listbox" aria-label="Versions">
        {versions.map((v, i) => {
          const isHead = v.revision === head;
          const active = selected === v.revision || (!selected && isHead);
          const previous = versions[i + 1]?.revision;
          const named = v.boardIds.map((id) => [id, boardName(id)] as const).filter(([, n]) => n);
          return (
            <div
              key={v.revision}
              role="option"
              aria-selected={active}
              className={"design-version" + (active ? " is-active" : "")}
              data-revision={v.revision}
              onClick={() => onSelect(isHead ? undefined : v.revision)}
            >
              <DesignAvatar author={v.author ?? { kind: "user" }} user={user} />
              <div className="design-version-body">
                <div className="design-version-head">
                  <strong>Version {v.revision}</strong>
                  <span>
                    {isHead ? " · Latest" : ""} · {relativeTime(v.createdAt)}
                  </span>
                </div>
                {v.summary && <p>{v.summary}</p>}
                {active && (
                  <div className="design-version-actions" onClick={(e) => e.stopPropagation()}>
                    {!isHead && (
                      <button disabled={!editable || busy} onClick={() => onRestore(v.revision)}>
                        Restore document
                      </button>
                    )}
                    {!isHead &&
                      named.slice(0, 2).map(([id, name]) => (
                        <button key={id} disabled={!editable || busy} onClick={() => onRestore(v.revision, id)}>
                          Restore {name} only
                        </button>
                      ))}
                    {previous !== undefined && named.length > 0 && (
                      <button onClick={() => onCompare(previous, v.revision, named[0][0])}>Compare</button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
