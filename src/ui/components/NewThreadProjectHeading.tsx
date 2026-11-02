import { useGitBranches } from '../hooks/useGitBranches';
import { openProjectNewChat } from '../utils/project-new-chat';
import { ComposerProjectPicker } from './ComposerProjectPicker';

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
