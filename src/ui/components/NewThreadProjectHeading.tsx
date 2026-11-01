import { useGitBranches } from '../hooks/useGitBranches';
import { useChatsFolder } from '../hooks/useChatsFolder';
import { openProjectNewChat } from '../utils/project-new-chat';
import { ComposerProjectPicker } from './ComposerProjectPicker';
import { Folder } from './icons';

export function NewThreadProjectHeading({ cwd, sessionId, disabled = false, onSelectProject, onSelectNoProject }: {
  cwd: string;
  sessionId?: string | null;
  disabled?: boolean;
  onSelectProject?: (cwd: string) => void;
  onSelectNoProject?: () => void;
}) {
  const { isRepo, loading } = useGitBranches(cwd);
  if (!cwd) return <>What should we work on?</>;

  // Reserve the hero while the project type resolves, avoiding build/work flicker.
  return <span style={{ visibility: loading ? 'hidden' : undefined }}>
    {isRepo ? 'What should we build in ' : 'What should we work on in '}
    <ComposerProjectPicker cwd={cwd} variant="hero" disabled={disabled}
      onSelect={onSelectProject ?? ((dir) => openProjectNewChat(dir, sessionId))}
      onSelectNoProject={onSelectNoProject} />
  </span>;
}

/** Under the composer of a new chat with no project: where its files will go. */
export function ChatFolderNote() {
  const folder = useChatsFolder();
  return (
    <div className="aegis-new-thread-chat-folder-note" title={folder.path || undefined}>
      <Folder className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">Files go to a new folder in {folder.display}</span>
    </div>
  );
}
