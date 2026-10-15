import { Trash2 } from "../icons";
import { DesignCover } from "./DesignCover";
import { relativeTime } from "./design-ui";
import type { DesignSummary } from "../../../shared/design-types";

/** "Edited 3h ago", "Edited just now", or the date once it is a week old. */
export function editedAgo(at: number) {
  const ago = relativeTime(at);
  return ago === "now" ? "Edited just now" : /^\d+[mhd]$/.test(ago) ? `Edited ${ago} ago` : `Edited ${ago}`;
}

/**
 * Designs as file cards: a cover of the canvas, the name and when it was
 * edited. Shared by a chat's Design tab and the Design section's home.
 */
export function DesignCards({
  designs,
  coverSession,
  onOpen,
  onDelete,
  tagMembers,
}: {
  designs: DesignSummary[];
  /** The chat whose view reads each cover (defaults to the design's own chat). */
  coverSession?: string;
  onOpen(design: DesignSummary): void;
  onDelete?(design: DesignSummary): void;
  /** Tag the designs the asking chat works on. */
  tagMembers?: boolean;
}) {
  return (
    <div className="design-document-list">
      {designs.map((d) => (
        <div key={d.id} className="design-document-item">
          <button
            type="button"
            className="design-document-card"
            data-design-document-card={d.id}
            onClick={() => onOpen(d)}
          >
            <DesignCover sessionId={coverSession ?? d.sessionId} documentId={d.id} revision={d.revision} />
            <span className="design-document-card-body">
              <strong title={d.title}>{d.title}</strong>
              <span>{editedAgo(d.updatedAt)}</span>
            </span>
            {tagMembers && d.member ? <span className="design-document-tag">This chat</span> : null}
          </button>
          {onDelete ? (
            <button
              type="button"
              className="design-document-delete"
              aria-label={`Delete ${d.title}`}
              title="Delete design"
              data-design-delete={d.id}
              onClick={() => onDelete(d)}
            >
              <Trash2 size={14} />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
