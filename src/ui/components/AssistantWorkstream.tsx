import { CompactionActivity } from './CompactionActivity';
import { BackgroundTaskEndedRow } from './BackgroundTaskEndedRow';
import { useWorkstreamDisclosure } from './WorkstreamDisclosureState';
import { ToolResultContent, ToolOutputPanel } from './ToolResultContent';
import { WorkstreamActivityLabel, WorkstreamCollapse, WorkstreamScrollArea, WorkstreamElapsed } from './WorkstreamPrimitives';
import { AttachmentPreviewGrid } from './AttachmentPreviewGrid';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { TraceChevron, TraceLine, TraceNest, TraceSpinner, type TraceTone } from './TraceLine';
import {
  ArrowUpRight,
  BrandGithub,
  BrandSlack,
  BrandNotion,
  BrandFigma,
  BrandGoogleDrive,
  CircleDashed,
  CircleX,
  FileDiff,
  FolderSearch,
  Globe,
  Brain,
  Lightbulb,
  Plug,
  ShieldAlert,
  SquareTerminal,
  Workflow,
} from './icons';
import { useAppStore } from '../store/useAppStore';
import {
  type ToolResultBlock,
  type ToolUseBlock,
  type WorkstreamEntry,
  type WorkstreamModel,
  getDelegateAgentFromBlock,
  getToolInputContent,
  getToolInputFilePath,
  getToolInputNewText,
  getToolInputOldText,
  getToolResultDiffContent,
  getToolResultOutputContent,
  safeJsonStringify,
} from '../utils/workstream';
import {
  createUnifiedDiffHunks,
  extractUnifiedDiffFilePath,
  parseUnifiedDiff,
  type UnifiedDiffHunk,
} from '../utils/unified-diff';
import { DiffHunkView } from './UnifiedDiffView';
import { InlineEditDiff } from './InlineEditDiff';
import { ComputerUseAppIcon } from './ComputerUseAppIcon';
import { TodoProgressCard } from './TodoProgressCard';
import { DiffStatLabel } from './DiffStatLabel';
import { useTurnDiffContext } from './TurnDiffContext';
import { StructuredResponse } from './StructuredResponse';
import type { ChangeRecord } from '../utils/change-records';
import {
  getStageChangeRecords,
  getWorkstreamDeniedActionIds,
  getWorkstreamFailureCount,
  getWorkstreamStageActivityKind,
  formatWorkstreamStageSummary,
  summarizeWorkstreamEntries,
  type WorkstreamStage,
  type WorkstreamStageCommand,
  type WorkstreamStageFile,
} from '../utils/workstream-stages';
import { FileTypeIcon } from './FileTypeIcon';
import { SubagentAvatar } from './SubagentAvatar';
import { getSubagentPersona } from '../utils/subagent-persona';
import { ProviderIcon } from './AgentModelPicker';
import { WorkflowBoard } from './workflow/WorkflowBoard';
import { isStartWorkflowToolName } from '../../shared/workflow';
import { isShowWidgetToolName, widgetFromToolInput } from '../../shared/widget';
import { InlineWidget } from './widget/InlineWidget';
import { ImageStudioSessionContext } from '../lib/image-studio';
import { useWidgetDraftStore, type WidgetDraft } from '../store/useWidgetDraftStore';
import { isRejectedWidget, isWidgetEntry, isWorkflowEntry, pinnedTurnEntries, type WidgetEntry } from '../utils/turn-pins';
import { stripLeakedContextTags } from '../utils/leaked-context-tags';
import type { AgentProvider } from '../../shared/types';
import { GeneratedMediaGallery } from './GeneratedMediaGallery';
import { isMediaGenerationTool, type GeneratedMediaItem } from '../utils/generated-media';

interface AssistantWorkstreamProps {
  model: WorkstreamModel;
  className?: string;
  generatedMedia?: GeneratedMediaItem[];
  mediaCwd?: string | null;
  /** The running turn's trace: also draws show_widget calls still being written. */
  live?: boolean;
}

const MAX_TRACE_TEXT_CHARS = 20_000;
const MAX_TITLE_CHARS = 800;

export function AssistantWorkstream({
  model,
  className = '',
  generatedMedia,
  mediaCwd,
  live = false,
}: AssistantWorkstreamProps) {
  // Hooks must run in the same order every render — keep useMemo above any
  // conditional early return.
  const drafts = useLiveWidgetDrafts(live, model.entries);
  const entryGroups = useMemo(() => groupEntries(model.entries), [model.entries]);
  // A draft sits where its call will land (the end of the trace), under the
  // same key, so the call takes over its frame instead of drawing a new one.
  const groups = useMemo<EntryGroup[]>(
    () => (drafts.length ? [...entryGroups, ...drafts.map((draft) => ({ kind: 'draft' as const, draft }))] : entryGroups),
    [drafts, entryGroups]
  );
  const lastMediaGroupIndex = useMemo(() => {
    if (!generatedMedia?.length) return -1;
    const mediaToolIds = new Set(
      generatedMedia.map((item) => item.toolUseId).filter((id): id is string => Boolean(id))
    );
    let lastCompact = -1;
    let lastMedia = -1;
    groups.forEach((group, index) => {
      if (group.kind !== 'compact') return;
      lastCompact = index;
      const hasReadyMediaTool = group.entries.some(
        (entry) =>
          entry.type === 'tool' &&
          entry.status !== 'pending' &&
          entry.status !== 'error' &&
          (isMediaGenerationTool(entry.toolName) || mediaToolIds.has(entry.block.id))
      );
      if (hasReadyMediaTool) lastMedia = index;
    });
    return lastMedia >= 0 ? lastMedia : lastCompact >= 0 ? lastCompact : groups.length - 1;
  }, [generatedMedia, groups]);

  if (model.entries.length === 0 && !model.todoProgress && drafts.length === 0) {
    return null;
  }

  return (
    <div className={`my-2 ${className}`.trim()}>
      {groups.map((group, idx) => {
        const groupKey = group.kind === 'compact' ? group.entries[0].id
          : group.kind === 'draft' ? `widget:${group.draft.toolUseId}`
          : group.kind === 'widget' ? `widget:${group.entry.block.id}`
          : group.entry.id;
        const body = group.kind === 'text' ? (
          <TextSegment key={groupKey} entry={group.entry} />
        ) : group.kind === 'widget' ? (
          <TraceWidget key={groupKey} entry={group.entry} />
        ) : group.kind === 'draft' ? (
          <TraceWidget key={groupKey} draft={group.draft} />
        ) : group.kind === 'compaction' ? (
          <CompactionActivity key={group.entry.id} entry={group.entry} />
        ) : group.kind === 'backgroundTaskEnded' ? (
          <BackgroundTaskEndedEntryRow key={group.entry.id} entry={group.entry} />
        ) : group.kind === 'thinking' ? (
          <ThinkingRow key={group.entry.id} entry={group.entry} />
        ) : (
          <CompactGroup
            key={groupKey}
            entries={group.entries}
            isLatestRunning={idx === groups.length - 1 && model.state === 'running' && !model.retrying}
          />
        );
        if (idx !== lastMediaGroupIndex || !generatedMedia?.length) {
          return body;
        }
        return (
          <div key={`${groupKey}-media`}>
            {body}
            <GeneratedMediaGallery items={generatedMedia} cwd={mediaCwd ?? null} />
          </div>
        );
      })}
      {model.state === 'running' && !model.retrying && groups.at(-1)?.kind !== 'compact' && drafts.length === 0 && !model.entries.some((entry) =>
        entry.type === 'compaction' ? entry.state === 'inProgress'
          : entry.type === 'thinking' ? entry.state === 'active'
          : entry.type === 'approval' ? entry.state === 'waiting'
          : 'status' in entry && entry.status === 'pending'
      ) ? <WorkingFooter /> : null}
      {model.todoProgress ? (
        <div className="my-2">
          <TodoProgressCard state={model.todoProgress} />
        </div>
      ) : null}
    </div>
  );
}

// ── Grouping ────────────────────────────────────────────────────────────────

type EntryGroup =
  | { kind: 'compaction'; entry: Extract<WorkstreamEntry, { type: 'compaction' }> }
  | { kind: 'backgroundTaskEnded'; entry: Extract<WorkstreamEntry, { type: 'backgroundTaskEnded' }> }
  | { kind: 'text'; entry: Extract<WorkstreamEntry, { type: 'note' }> }
  | { kind: 'thinking'; entry: Extract<WorkstreamEntry, { type: 'thinking' }> }
  | { kind: 'widget'; entry: WidgetEntry }
  | { kind: 'draft'; draft: WidgetDraft }
  | { kind: 'compact'; entries: WorkstreamEntry[] };

/** The session's show_widget calls still being written that no entry has taken over yet. */
export function useLiveWidgetDrafts(live: boolean, entries: WorkstreamEntry[]): WidgetDraft[] {
  const sessionId = useContext(ImageStudioSessionContext);
  const sessionDrafts = useWidgetDraftStore((state) => (live && sessionId ? state.drafts[sessionId] : undefined));
  return useMemo(() => {
    if (!sessionDrafts) return [];
    const called = new Set(entries.flatMap((entry) => ('block' in entry && entry.block ? [entry.block.id] : [])));
    return Object.values(sessionDrafts)
      .filter((draft) => !called.has(draft.toolUseId))
      .sort((a, b) => a.order - b.order);
  }, [entries, sessionDrafts]);
}

/** Drafts of a running turn that has no trace to draw them in yet. */
export function LiveWidgetDrafts() {
  const drafts = useLiveWidgetDrafts(true, []);
  if (drafts.length === 0) return null;
  return (
    <>
      {drafts.map((draft) => (
        <InlineWidget key={draft.toolUseId} toolUseId={draft.toolUseId} html={draft.html} title={draft.title} draft />
      ))}
    </>
  );
}

function groupEntries(entries: WorkstreamEntry[]): EntryGroup[] {
  const groups: EntryGroup[] = [];
  let buffer: WorkstreamEntry[] = [];

  const flush = () => {
    if (buffer.length > 0) {
      groups.push({ kind: 'compact', entries: buffer });
      buffer = [];
    }
  };

  for (const entry of entries) {
    if (entry.type === 'compaction') {
      flush();
      groups.push({ kind: 'compaction', entry });
    } else if (entry.type === 'backgroundTaskEnded') {
      flush();
      groups.push({ kind: 'backgroundTaskEnded', entry });
    } else if (entry.type === 'note') {
      flush();
      groups.push({ kind: 'text', entry });
    } else if (entry.type === 'thinking') {
      flush();
      groups.push({ kind: 'thinking', entry });
    } else if (isWidgetEntry(entry)) {
      // A widget is part of the answer, drawn where the agent placed it.
      flush();
      groups.push({ kind: 'widget', entry });
    } else {
      buffer.push(entry);
    }
  }
  flush();
  return groups;
}

// ── Text segment (assistant narration during the trace) ─────────────────────

function TextSegment({
  entry,
}: {
  entry: Extract<WorkstreamEntry, { type: 'note' }>;
}) {
  const pinned = useContext(PinnedNoteIds);
  const text = entry.detail || entry.summary;
  // Shown with the turn's widgets instead (see TurnWorkflowBoards).
  if (pinned.has(entry.id)) return null;
  // A segment that was only an echoed context tag leaves no empty gap.
  if (!stripLeakedContextTags(text, entry.state === 'streaming').trim()) return null;
  const displayText = truncateWithNotice(text, MAX_TRACE_TEXT_CHARS);
  return (
    <div className="my-2 min-w-0 overflow-x-auto">
      <StructuredResponse content={displayText} streaming={entry.state === 'streaming'} />
    </div>
  );
}

// ── Compact group with overflow ─────────────────────────────────────────────

function CompactGroup({
  entries,
  isLatestRunning,
}: {
  entries: WorkstreamEntry[];
  isLatestRunning: boolean;
}) {
  const { changeRecordsByToolUseId, onOpenDiff } = useTurnDiffContext();
  const stages = useMemo(
    () => summarizeWorkstreamEntries(entries, { changeRecordsByToolUseId }),
    [changeRecordsByToolUseId, entries]
  );
  const activeStage = [...stages].reverse().find((stage) => stage.status === 'pending' || stage.status === 'waiting' || stage.entries.some(entry => 'status' in entry && entry.status === 'pending'));
  const [expanded, setExpanded] = useWorkstreamDisclosure(`group:${entries[0]?.id}`, stages.some((stage) => stage.defaultExpanded));
  const showGroup = stages.length > 1;
  const thinking = isLatestRunning && !activeStage;
  const headerStage = activeStage || stages[0];
  const headerActive = thinking || Boolean(activeStage?.entries.some(entry => 'status' in entry && entry.status === 'pending'));
  const stageRows = (
    <WorkstreamScrollArea followKey={activeStage?.id}>
      {stages.map((stage) =>
        stage.kind === 'task' ? (
          <SubagentStage key={stage.id} stage={stage} />
        ) : (
          <StageRow key={stage.id} stage={stage} onOpenDiff={onOpenDiff} />
        )
      )}
    </WorkstreamScrollArea>
  );
  return (
    <div className="my-2 space-y-px">
      {showGroup && <TraceLine data-workstream-group aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        tone={headerActive ? 'active' : 'default'}
        icon={thinking || !headerStage ? <Lightbulb /> : <StageKindIcon stage={headerStage} />}
        title={<WorkstreamActivityLabel active={headerActive} activityKey={thinking ? 'thinking' : activeStage?.id}>
          {thinking ? 'Thinking' : activeStage?.title || formatWorkstreamStageSummary(stages)}
        </WorkstreamActivityLabel>}
        meta={<FailureCount entries={entries} />}
        trail={<TraceChevron expanded={expanded} />}
      />}
      <WorkstreamCollapse open={!showGroup || expanded}>
        {showGroup ? <TraceNest>{stageRows}</TraceNest> : stageRows}
      </WorkstreamCollapse>
      {!showGroup && thinking && <WorkingFooter label="Thinking" />}
    </div>
  );
}

// ── Stage summary rows ─────────────────────────────────────────────────────

function FailureCount({ entries }: { entries: WorkstreamEntry[] }) {
  const count = getWorkstreamFailureCount(entries);
  return count > 0 ? <span className="trace-meta-error">{count} failed</span> : null;
}

/** A lone command's non-zero exit code, shown in the line's meta instead of under the output. */
function getStageMetaExitCode(stage: WorkstreamStage): number | null {
  const exitCode = stage.commands.length === 1 ? stage.commands[0].execution?.exitCode : null;
  return exitCode != null && exitCode !== 0 ? exitCode : null;
}

function StageRow({
  stage,
  onOpenDiff,
}: {
  stage: WorkstreamStage;
  onOpenDiff?: (
    record: ChangeRecord,
    scope?: { records: ChangeRecord[]; label?: string; turnKey?: string }
  ) => void;
}) {
  const [expanded, setExpanded] = useWorkstreamDisclosure(
    `stage:${stage.entries[0]?.id}`,
    stage.defaultExpanded
  );

  const hasDetails = stage.entries.some(hasRawEntryDetail);
  const canExpand =
    stage.files.length > 0 ||
    stage.commands.length > 0 ||
    hasDetails ||
    (stage.kind === 'computer_use' && stage.entries.some(hasComputerUseStageDetail));
  const isPending = stage.status === 'pending';
  const execution = stage.commands[0]?.execution;
  const denied = stage.entries.some(entry => getWorkstreamDeniedActionIds(entry).length > 0);
  const exitCode = getStageMetaExitCode(stage);
  const failed = exitCode != null || getWorkstreamFailureCount(stage.entries) > 0;
  const tone: TraceTone = stage.status === 'waiting' ? 'waiting' : isPending ? 'active' : failed ? 'error' : 'default';

  return (
    <div data-workstream-stage={stage.id} data-denied-action={denied || undefined} tabIndex={denied ? -1 : undefined}>
      <TraceLine
        onClick={() => canExpand && setExpanded(!expanded)}
        disabled={!canExpand}
        aria-expanded={canExpand ? expanded : undefined}
        tone={tone}
        hint={stage.files.length === 1 ? stage.files[0].filePath : undefined}
        icon={<StageKindIcon stage={stage} />}
        title={<WorkstreamActivityLabel active={isPending}>{stage.title}</WorkstreamActivityLabel>}
        meta={<>
          <WorkstreamElapsed {...execution} running={isPending} />
          {stage.kind === 'edit' ? (
            <DiffStatLabel additions={stage.addedLines} deletions={stage.removedLines} muted />
          ) : null}
          {exitCode != null ? <span className="trace-meta-error">exit {exitCode}</span> : <FailureCount entries={stage.entries} />}
          {stage.status === 'interrupted' ? <span>Interrupted</span> : null}
        </>}
        trail={<StageStatusGlyph stage={stage} expanded={expanded} canExpand={canExpand} />}
      />
      <WorkstreamCollapse open={expanded && canExpand}>
        <StageDetails stage={stage} onOpenDiff={onOpenDiff} />
      </WorkstreamCollapse>
    </div>
  );
}

function StageKindIcon({ stage }: { stage: WorkstreamStage }) {
  const kind = getWorkstreamStageActivityKind(stage);
  if (kind === 'edit') return <FileDiff />;
  if (kind === 'command') return <SquareTerminal />;
  if (kind === 'approval') return <ShieldAlert />;
  if (kind === 'computer_use') return <ComputerUseAppIcon app={stage.computerUseApp} className="" />;
  if (kind === 'error') return <CircleX />;
  if (kind === 'web') return <Globe />;
  if (kind === 'memory') return <Brain />;
  if (kind === 'other') {
    const Icon = ({ GitHub: BrandGithub, Slack: BrandSlack, Notion: BrandNotion, Figma: BrandFigma, 'Google Drive': BrandGoogleDrive, Browser: Globe })[stage.source ?? ''] || Plug;
    return <Icon />;
  }
  return <FolderSearch />;
}

function StageStatusGlyph({
  stage,
  expanded,
  canExpand,
}: {
  stage: WorkstreamStage;
  expanded: boolean;
  canExpand: boolean;
}) {
  if (stage.status === 'pending') return <TraceSpinner />;
  if (stage.status === 'interrupted') return <CircleDashed />;
  // A waiting stage already says so in its amber icon and title.
  if (stage.status === 'waiting' || !canExpand) return null;
  return <TraceChevron expanded={expanded} />;
}

function StageDetails({
  stage,
  onOpenDiff,
}: {
  stage: WorkstreamStage;
  onOpenDiff?: (
    record: ChangeRecord,
    scope?: { records: ChangeRecord[]; label?: string; turnKey?: string }
  ) => void;
}) {
  const showGenericDetail = stage.files.length === 0 && stage.commands.length === 0 && stage.kind !== 'computer_use';
  const images = Array.from(new Map(stage.entries.flatMap((entry) =>
    entry.type === 'tool' ? entry.result?.images || [] : []).map((image) => [image.id, image])).values());

  return (
    <TraceNest className="mb-1 space-y-1">
      {stage.entries.flatMap(entry => 'execution' in entry ? entry.execution?.approvalReviews ?? [] : []).map(review =>
        <div key={review.id} className="workstream-text text-[var(--text-secondary)]">
          {review.status === 'timedOut' ? 'Approval review timed out' : 'Action denied'}{review.reason ? `: ${review.reason}` : ''}
        </div>
      )}
      {stage.files.length > 0 ? (
        <StageFilesDetail stage={stage} onOpenDiff={onOpenDiff} />
      ) : null}
      {images.length > 0 && !showGenericDetail && stage.kind !== 'computer_use' ? <AttachmentPreviewGrid attachments={images} align="start" /> : null}
      {stage.commands.length > 0 ? <StageCommandsDetail commands={stage.commands} exitInMeta={getStageMetaExitCode(stage) != null} /> : null}
      {stage.kind === 'computer_use' ? <StageComputerUseDetail entries={stage.entries} /> : null}
      {showGenericDetail && stage.kind === 'edit' && stage.status !== 'error' ? (
        <div className="px-2 py-1 text-[11px] text-[var(--text-muted)]">
          {stage.status === 'pending' ? 'Waiting for file change details…' : 'File change details were not recorded for this edit.'}
        </div>
      ) : showGenericDetail ? (
        <StageGenericDetail entries={stage.entries} />
      ) : stage.status === 'error' ? (
        <StageFailureNotes entries={stage.entries} />
      ) : null}
    </TraceNest>
  );
}

// Command failures already show their output in StageCommandsDetail, so the
// failure notes only cover the remaining failed entries (e.g. a rejected Edit).
function hasComputerUseStageDetail(entry: WorkstreamEntry): boolean {
  if (entry.type !== 'tool' && entry.type !== 'task' && entry.type !== 'memory') return false;
  return hasEntryDetail(entry);
}

function StageComputerUseDetail({ entries }: { entries: WorkstreamEntry[] }) {
  return <StageGenericDetail entries={entries} />;
}

function StageGenericDetail({ entries }: { entries: WorkstreamEntry[] }) {
  const tools = entries.filter(
    (entry): entry is Extract<WorkstreamEntry, { type: 'tool' | 'task' | 'memory' }> =>
      entry.type === 'tool' || entry.type === 'task' || entry.type === 'memory'
  );
  if (tools.length === 0) return <StageErrorFallback entries={entries} />;
  return (
    <div className="space-y-2">
      {tools.map((entry) => (
        tools.length > 1 ? <ToolRow key={entry.id} entry={entry} /> : <ToolEntryDetail key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

function ComputerUseScreenshots({ refs }: { refs: NonNullable<ToolResultBlock['mediaRefs']> }) {
  const [previews, setPreviews] = useState<Record<string, string | null>>({});

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      refs.map(async (ref) => {
        try {
          const dataUrl = await window.electron.readComputerUseArtifact(ref.sessionId, ref.sha256);
          return [ref.sha256, dataUrl] as const;
        } catch {
          return [ref.sha256, null] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setPreviews(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [refs]);

  return (
    <div className="flex flex-wrap gap-2">
      {refs.map((ref) => (
        <div
          key={ref.sha256}
          className="overflow-hidden rounded border border-[var(--border)]/50 bg-[var(--bg-secondary)]"
        >
          {previews[ref.sha256] ? (
            <img src={previews[ref.sha256] || ''} alt="Computer use screenshot" className="max-h-40 max-w-full" />
          ) : (
            <div className="px-2 py-1 text-[11px] text-[var(--text-muted)]">Screenshot saved</div>
          )}
        </div>
      ))}
    </div>
  );
}

function StageFailureNotes({ entries }: { entries: WorkstreamEntry[] }) {
  const failed = entries.filter(isFailedNonCommandEntry);
  if (failed.length === 0) return null;

  return (
    <div className="space-y-1">
      {failed.map((entry) => (
        <FailureNote key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

function isFailedNonCommandEntry(entry: WorkstreamEntry): boolean {
  if ('kind' in entry && entry.kind === 'command_execution') return false;
  if (entry.type === 'error') return true;
  if (entry.type === 'approval') return entry.state === 'denied';
  if (entry.type === 'tool' || entry.type === 'task' || entry.type === 'memory') {
    return entry.status === 'error';
  }
  return false;
}

function getEntryFailureText(entry: WorkstreamEntry): string {
  if (entry.type === 'tool' || entry.type === 'task' || entry.type === 'memory') {
    const output = getToolResultOutputContent(entry.result).trim();
    if (output) return output;
  }
  return (entry.detail || '').trim();
}

function FailureNote({ entry }: { entry: WorkstreamEntry }) {
  const text = getEntryFailureText(entry);
  return (
    <div className="overflow-hidden rounded-sm border border-[var(--border)]/45 bg-[var(--bg-secondary)]/30">
      <div
        className={`flex items-center gap-1.5 px-2 py-1 text-[11px] text-[var(--error)] ${
          text ? 'border-b border-[var(--border)]/45' : ''
        }`}
      >
        <CircleX className="h-3 w-3 flex-shrink-0" />
        <span className="min-w-0 flex-1 truncate">{entry.summary}</span>
      </div>
      {text ? <TailClampedOutput text={text} toneClass="text-[var(--error)]" /> : null}
    </div>
  );
}

function StageErrorFallback({
  entries,
}: {
  entries: WorkstreamEntry[];
}) {
  const visibleEntries = entries.filter(hasRawEntryDetail);
  if (visibleEntries.length === 0) return null;

  return (
    <div className="space-y-px">
      {visibleEntries.map((entry) => (
        <EntryRow key={entry.id} entry={entry} showChangeHint={false} />
      ))}
    </div>
  );
}

function StageFilesDetail({
  stage,
  onOpenDiff,
}: {
  stage: WorkstreamStage;
  onOpenDiff?: (
    record: ChangeRecord,
    scope?: { records: ChangeRecord[]; label?: string; turnKey?: string }
  ) => void;
}) {
  const records = getStageChangeRecords(stage);
  return (
    <div className="space-y-px">
      {stage.files.map((file) => stage.kind === 'edit' && file.record ? (
        <InlineEditDiff key={file.id} record={file.record} onOpen={onOpenDiff ? () => onOpenDiff(file.record!, { records, label: stageFileScopeLabel(records.length) }) : undefined} />
      ) : (
        <StageFileRow
          key={file.id}
          file={file}
          records={records}
          onOpenDiff={onOpenDiff}
        />
      ))}
    </div>
  );
}

function StageFileRow({
  file,
  records,
  onOpenDiff,
}: {
  file: WorkstreamStageFile;
  records: ChangeRecord[];
  onOpenDiff?: (
    record: ChangeRecord,
    scope?: { records: ChangeRecord[]; label?: string; turnKey?: string }
  ) => void;
}) {
  const clickable = Boolean(file.record && onOpenDiff);
  const operationLabel = formatFileOperation(file.operation);
  const body = (
    <>
      <FileTypeIcon name={file.fileName} className="h-3.5 w-3.5 flex-shrink-0 opacity-75" />
      <span className="w-12 flex-shrink-0 text-[var(--text-muted)]/60">{operationLabel}</span>
      <span
        className={`min-w-0 flex-1 truncate font-mono ${
          clickable ? 'text-[var(--accent)] group-hover/file:underline' : 'text-[var(--text-secondary)]'
        }`}
      >
        {file.filePath}
      </span>
      <DiffStatLabel additions={file.addedLines} deletions={file.removedLines} />
    </>
  );

  if (clickable && file.record) {
    return (
      <button
        type="button"
        onClick={() =>
          onOpenDiff?.(file.record!, {
            records,
            label: stageFileScopeLabel(records.length),
          })
        }
        title={file.filePath}
        className="group/file flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left workstream-text transition-colors hover:bg-[var(--bg-tertiary)]/30"
      >
        {body}
      </button>
    );
  }

  return (
    <div
      title={file.filePath}
      className="flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 workstream-text"
    >
      {body}
    </div>
  );
}

function StageCommandsDetail({ commands, exitInMeta }: { commands: WorkstreamStageCommand[]; exitInMeta: boolean }) {
  return (
    <div className="space-y-1">
      {commands.map((command) => (
        <div key={command.id}>
          <ToolOutputPanel follow language="shell" isError={command.status === 'error'}
            text={`$ ${command.command}${command.output ? `\n${command.output}` : ''}`} />
          {command.execution?.exitCode != null && !exitInMeta && <div className="workstream-text mt-1 text-[var(--text-muted)]">Exit code {command.execution.exitCode}</div>}
        </div>
      ))}
    </div>
  );
}

const OUTPUT_PREVIEW_LINES = 8;

function TailClampedOutput({ text, toneClass }: { text: string; toneClass: string }) {
  const [showFull, setShowFull] = useState(false);
  const lines = text.split('\n');
  const hiddenLines = lines.length - OUTPUT_PREVIEW_LINES;
  const displayText =
    showFull || hiddenLines <= 0
      ? truncateWithNotice(text, MAX_TRACE_TEXT_CHARS)
      : lines.slice(-OUTPUT_PREVIEW_LINES).join('\n');

  return (
    <>
      {hiddenLines > 0 ? (
        <button
          type="button"
          onClick={() => setShowFull((value) => !value)}
          className="flex w-full items-center px-2 py-0.5 text-left text-[11px] text-[var(--text-muted)]/70 transition-colors hover:text-[var(--text-secondary)]"
        >
          {showFull ? 'Show fewer lines' : `Show ${hiddenLines} earlier lines`}
        </button>
      ) : null}
      <pre
        className={`whitespace-pre-wrap break-words px-2 py-1 font-mono text-[11px] leading-5 ${toneClass}`}
      >
        {displayText}
      </pre>
    </>
  );
}

function formatFileOperation(operation: WorkstreamStageFile['operation']): string {
  if (operation === 'write' || operation === 'added') return 'Created';
  if (operation === 'delete' || operation === 'deleted') return 'Deleted';
  if (operation === 'renamed') return 'Moved';
  if (operation === 'read') return 'Read';
  if (operation === 'search') return 'Searched';
  return 'Edited';
}

function stageFileScopeLabel(count: number): string {
  return count === 1 ? 'Selected file changes' : `${count} files changed in this stage`;
}

function hasRawEntryDetail(entry: WorkstreamEntry): boolean {
  if (entry.type === 'tool' || entry.type === 'task' || entry.type === 'memory') {
    return hasEntryDetail(entry);
  }
  return Boolean(entry.detail);
}

// ── Subagent stage (Task tool calls) ────────────────────────────────────────
// A single Task renders as a standalone lane row; parallel Tasks merge into a
// board card with one lane per subagent. Each lane is a compact chip row —
// clicking it opens the subagent's own tab in the right-side detail panel,
// which is the only place the subagent's working trace renders.

type TaskEntry = Extract<WorkstreamEntry, { type: 'task' }>;

function isTaskEntry(entry: WorkstreamEntry): entry is TaskEntry {
  return entry.type === 'task';
}


/**
 * Workflow boards, chat widgets and the reply text around the widgets belong
 * to the answer, not to the work trace: when a finished turn's trace
 * collapses, the turn renders them outside the collapsible body (in order,
 * see pinnedTurnEntries) and the trace leaves them out.
 */
const WorkflowBoardsOutside = createContext(false);
export const WorkflowBoardsOutsideProvider = WorkflowBoardsOutside.Provider;
const PinnedNoteIds = createContext<ReadonlySet<string>>(new Set());
export const PinnedNoteIdsProvider = PinnedNoteIds.Provider;

export function TurnWorkflowBoards({ entries }: { entries: WorkstreamEntry[] }) {
  const pinned = useMemo(() => pinnedTurnEntries(entries), [entries]);
  if (pinned.length === 0) return null;
  return (
    <>
      {pinned.map((entry) =>
        isWidgetEntry(entry) ? (
          <WidgetFromEntry key={entry.id} entry={entry} />
        ) : entry.type === 'note' ? (
          <div key={entry.id} className="my-2 min-w-0 overflow-x-auto">
            <StructuredResponse content={entry.detail || entry.summary} />
          </div>
        ) : (
          <WorkflowEntryBoard key={entry.id} entry={entry as TaskEntry} />
        )
      )}
    </>
  );
}

/**
 * A call the tool hasn't answered yet draws its markup without running its
 * scripts (a refused one then disappears); once accepted it comes alive.
 */
function widgetProps(entry: WidgetEntry) {
  const widget = widgetFromToolInput(entry.block.input);
  if (!widget || isRejectedWidget(entry)) return null;
  return { toolUseId: entry.block.id, html: widget.html, title: widget.title, draft: entry.status !== 'success' };
}

function WidgetFromEntry({ entry }: { entry: WidgetEntry }) {
  const props = widgetProps(entry);
  return props ? <InlineWidget {...props} /> : null;
}

/**
 * A widget inside a running trace — a call, or a draft still being written —
 * rendered as the same element either way, so a draft's frame carries over
 * to its call. Collapsed turns draw their widgets outside instead.
 */
function TraceWidget({ entry, draft }: { entry?: WidgetEntry; draft?: WidgetDraft }) {
  const outside = useContext(WorkflowBoardsOutside);
  const props = draft
    ? { toolUseId: draft.toolUseId, html: draft.html, title: draft.title, draft: true }
    : entry ? widgetProps(entry) : null;
  return outside || !props ? null : <InlineWidget {...props} />;
}

/** A start_workflow call: the workflow it started, live, in place of a subagent lane. */
function WorkflowEntryBoard({ entry }: { entry: TaskEntry }) {
  const resultText = entry.result ? getToolResultOutputContent(entry.result) : null;
  return (
    <WorkflowBoard
      toolUseId={entry.block.id}
      resultText={resultText}
      failed={entry.status === 'error' || entry.result?.is_error === true}
    />
  );
}

function SubagentStage({ stage }: { stage: WorkstreamStage }) {
  const outside = useContext(WorkflowBoardsOutside);
  const workflows = stage.entries.filter(isWorkflowEntry);
  if (workflows.length > 0) {
    const rest = stage.entries.filter((entry) => !isWorkflowEntry(entry));
    return (
      <>
        {outside
          ? null
          : workflows.map((entry) => (
              <WorkflowEntryBoard key={entry.id} entry={entry} />
            ))}
        {rest.length > 0 ? <SubagentStage stage={{ ...stage, entries: rest }} /> : null}
      </>
    );
  }
  const taskEntries = stage.entries.filter(isTaskEntry);
  // Anything classified into a task stage that didn't map to a task entry
  // still renders as a plain row instead of silently disappearing.
  if (taskEntries.length === 0) {
    return (
      <div className="space-y-px">
        {stage.entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} />
        ))}
      </div>
    );
  }
  if (taskEntries.length === 1) {
    return <SubagentLane entry={taskEntries[0]} standalone />;
  }
  return <SubagentBoard entries={taskEntries} />;
}

function SubagentBoard({ entries }: { entries: TaskEntry[] }) {
  const running = entries.filter((entry) => entry.status === 'pending').length;
  const failed = entries.filter((entry) => entry.status === 'error').length;
  const stopped = entries.filter((entry) => entry.status === 'interrupted').length;
  const done = entries.length - running - failed - stopped;
  const metaParts: string[] = [];
  if (done > 0) metaParts.push(`${done} done`);
  if (running > 0) metaParts.push(`${running} running`);
  if (failed > 0) metaParts.push(`${failed} failed`);
  if (stopped > 0) metaParts.push(`${stopped} stopped`);

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/40">
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--accent-light)] px-2.5 py-1.5">
        <Workflow className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text-primary)]">
          {entries.length} subagents in parallel
        </span>
        <span className="flex-shrink-0 font-mono text-[10.5px] text-[var(--text-muted)]">
          {metaParts.join(' · ')}
        </span>
      </div>
      <div className="divide-y divide-[var(--border)]/60">
        {entries.map((entry) => (
          <SubagentLane key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function SubagentLane({
  entry,
  standalone = false,
}: {
  entry: TaskEntry;
  standalone?: boolean;
}) {
  const trace = entry.subagent;
  const description = trace?.description || getTaskDescription(entry) || entry.summary;
  // The avatar hue is derived from the Task tool_use id — the same key the
  // subagent registry / utility tabs use — so the chat row and the tab show
  // the same pixel creature for one subagent. Cross-agent delegations show
  // the target agent's provider logo instead.
  const persona = getSubagentPersona(entry.block.id, trace?.agentType, description);
  const delegateAgent = getDelegateAgentFromBlock(entry.block) as AgentProvider | null;

  const pending = entry.status === 'pending';
  const stats = buildSubagentLaneStats(entry);

  // The whole row opens this subagent's tab in the right-side detail panel —
  // the subagent's working trace lives there, not inline in the main trace.
  return (
    <TraceLine
      onClick={() => useAppStore.getState().openSubagentPanel(entry.block.id)}
      hint={safeTitle(stats.length > 0 ? `${description}\n${stats.join(' · ')}` : description)}
      className={standalone ? '' : 'px-2.5 py-1'}
      tone={pending ? 'active' : entry.status === 'error' ? 'error' : 'default'}
      icon={delegateAgent ? (
        <ProviderIcon provider={delegateAgent} />
      ) : (
        <SubagentAvatar id={entry.block.id} hue={persona.colorHue} size={14} />
      )}
      title={<WorkstreamActivityLabel active={pending}>{description}</WorkstreamActivityLabel>}
      meta={<>
        {stats.length > 0 ? <span>{stats.join(' · ')}</span> : null}
        {entry.status === 'error' ? <span className="trace-meta-error">Failed</span>
          : entry.status === 'interrupted' ? <span>Interrupted</span> : null}
      </>}
      trail={pending ? <TraceSpinner /> : <ArrowUpRight />}
    />
  );
}

/** Agent type, tool count and duration, shown in the line's meta. */
function buildSubagentLaneStats(entry: TaskEntry): string[] {
  const trace = entry.subagent;
  const parts: string[] = [];
  if (trace?.agentType) parts.push(trace.agentType);
  if (trace && trace.toolCount > 0) {
    parts.push(`${trace.toolCount} ${trace.toolCount === 1 ? 'tool' : 'tools'}`);
  }
  if (typeof trace?.durationMs === 'number') {
    parts.push(formatElapsed(trace.durationMs));
  }
  return parts;
}

function getTaskDescription(entry: TaskEntry): string | null {
  const input = isRecord(entry.block.input) ? entry.block.input : {};
  const description = input.description;
  if (typeof description === 'string' && description.trim()) {
    return description;
  }
  // Bubble's spawn surface uses message/task instead of prompt.
  for (const key of ['prompt', 'message', 'task'] as const) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

// ── Entry row dispatcher ────────────────────────────────────────────────────

function EntryRow({ entry, showChangeHint = true }: { entry: WorkstreamEntry; showChangeHint?: boolean }) {
  const workflowsOutside = useContext(WorkflowBoardsOutside);
  if (entry.type === 'compaction') return <CompactionActivity entry={entry} />;
  if (entry.type === 'backgroundTaskEnded') return <BackgroundTaskEndedEntryRow entry={entry} />;
  if (entry.type === 'task') {
    if (isStartWorkflowToolName(entry.toolName)) return workflowsOutside ? null : <WorkflowEntryBoard entry={entry} />;
    // Task entries render as a subagent chip row rather than a generic tool
    // row — clicking the chip opens the subagent's tab in the detail panel,
    // where its full working trace lives.
    return <SubagentLane entry={entry} standalone />;
  }
  if (entry.type === 'thinking') {
    return <ThinkingRow entry={entry} />;
  }
  if (entry.type === 'note') {
    return <StreamingNoteRow entry={entry} />;
  }
  if (entry.type === 'approval') {
    return <ApprovalRow entry={entry} />;
  }
  if (entry.type === 'error') {
    return <ErrorRow entry={entry} />;
  }
  return <ToolRow entry={entry} showChangeHint={showChangeHint} />;
}

function StreamingNoteRow({
  entry,
}: {
  entry: Extract<WorkstreamEntry, { type: 'note' }>;
}) {
  const isStreaming = entry.state === 'streaming';
  return (
    <div
      className="flex items-baseline gap-1.5 py-0.5 text-[12px] leading-5 text-[var(--text-muted)]/55"
      title={safeTitle(entry.detail)}
    >
      <span className="min-w-0 flex-1 truncate">{entry.summary}</span>
      {isStreaming ? (
        <span className="inline-flex h-1 w-1 flex-shrink-0 rounded-full bg-[var(--text-muted)]/45 animate-pulse" />
      ) : null}
    </div>
  );
}

// ── Thinking row ────────────────────────────────────────────────────────────

function ThinkingRow({
  entry,
}: {
  entry: Extract<WorkstreamEntry, { type: 'thinking' }>;
}) {
  const isActive = entry.state === 'active';
  const [expanded, setExpanded] = useWorkstreamDisclosure(`reasoning:${entry.id}`);
  const text = entry.detail || entry.summary;
  return (
    <div className="my-2">
      <TraceLine aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
        tone={isActive ? 'active' : 'default'}
        icon={<Lightbulb />}
        title={<WorkstreamActivityLabel active={isActive}>{isActive ? 'Thinking' : 'Reasoning'}</WorkstreamActivityLabel>}
        meta={entry.state === 'interrupted' ? <span>Interrupted</span> : null}
        trail={<TraceChevron expanded={expanded} />}
      />
      <WorkstreamCollapse open={expanded}>
        <TraceNest>
          <WorkstreamScrollArea followKey={isActive ? entry.id : undefined}>
            {/* Reasoning is plain text in a height-bounded scroll area, so the full
                trace renders cheaply — no MAX_TRACE_TEXT_CHARS cap here. */}
            <div className="trace-text py-1 text-[var(--text-secondary)] whitespace-pre-wrap break-words">
              {text}
            </div>
          </WorkstreamScrollArea>
        </TraceNest>
      </WorkstreamCollapse>
    </div>
  );
}

// ── Approval row ────────────────────────────────────────────────────────────

function ApprovalRow({
  entry,
}: {
  entry: Extract<WorkstreamEntry, { type: 'approval' }>;
}) {
  return (
    <TraceLine
      as="div"
      tone={entry.state === 'waiting' ? 'waiting' : 'default'}
      hint={safeTitle(entry.detail)}
      icon={<ShieldAlert />}
      // The detail truncates with the summary; the meta keeps only the state word.
      title={<>{entry.summary}{entry.detail ? <span className="text-[var(--text-muted)]"> · {entry.detail}</span> : null}</>}
      meta={entry.state === 'denied' ? <span className="trace-meta-error">Denied</span>
        : <span>{entry.state === 'approved' ? 'Approved' : 'Waiting'}</span>}
    />
  );
}

// ── Error row ───────────────────────────────────────────────────────────────

function ErrorRow({
  entry,
}: {
  entry: Extract<WorkstreamEntry, { type: 'error' }>;
}) {
  return (
    <TraceLine
      as="div"
      tone="error"
      hint={safeTitle(entry.detail)}
      icon={<CircleX />}
      title={<span className="text-[var(--error)]">{entry.summary}</span>}
    />
  );
}

// ── Tool/task/memory row (one compact line per item) ────────────────────────

function ToolRow({
  entry,
  showChangeHint = true,
}: {
  entry: Extract<WorkstreamEntry, { type: 'tool' | 'task' | 'memory' }>;
  showChangeHint?: boolean;
}) {
  const [expanded, setExpanded] = useWorkstreamDisclosure(`tool:${entry.id}`);
  const { changeRecordByToolUseId, onOpenDiff } = useTurnDiffContext();
  const changeRecord = changeRecordByToolUseId.get(entry.block.id) || null;
  // A one-entry stage picks the same kind icon the stage rows use.
  const iconStage = useMemo(() => summarizeWorkstreamEntries([entry])[0], [entry]);

  const canExpand = hasEntryDetail(entry);
  const isPending = entry.status === 'pending';
  const isError = entry.status === 'error';

  return (
    <div>
      <TraceLine
        onClick={() => canExpand && setExpanded(!expanded)}
        aria-expanded={canExpand ? expanded : undefined}
        disabled={!canExpand}
        hint={safeTitle(entry.detail || entry.summary)}
        tone={isPending ? 'active' : isError ? 'error' : 'default'}
        icon={iconStage ? <StageKindIcon stage={iconStage} /> : <Plug />}
        title={<WorkstreamActivityLabel active={isPending}>{entry.summary}</WorkstreamActivityLabel>}
        meta={isError ? <span className="trace-meta-error">Failed</span>
          : entry.status === 'interrupted' ? <span>Interrupted</span> : null}
        trail={isPending ? <TraceSpinner />
          : entry.status === 'interrupted' ? <CircleDashed />
          : canExpand ? <TraceChevron expanded={expanded} /> : null}
      />

      {showChangeHint && changeRecord ? (
        <EditedFileHint record={changeRecord} onOpen={onOpenDiff} />
      ) : null}

      {expanded && isPending && entry.type === 'tool' && entry.liveOutput ? (
        <LiveToolOutputTail text={entry.liveOutput} />
      ) : null}

      {expanded && canExpand ? (
        <TraceNest className="mb-1">
          <ToolEntryDetail entry={entry} />
        </TraceNest>
      ) : null}
    </div>
  );
}

/**
 * Terminal-style tail of a running tool's streamed stdout/stderr: the last
 * few lines only — the full output arrives with the tool result. Lines with
 * carriage-return rewrites (progress bars) collapse to their final frame.
 */
function LiveToolOutputTail({ text }: { text: string }) {
  const tail = useMemo(() => {
    const lines = text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.split('\r').pop() || '')
      .filter((line) => line.trim().length > 0);
    return lines.slice(-6).join('\n');
  }, [text]);

  if (!tail) return null;
  return (
    <TraceNest className="mb-1">
      <pre className="max-h-28 overflow-hidden whitespace-pre-wrap break-all font-mono text-[11px] leading-4 text-[var(--text-muted)]/70">
        {tail}
      </pre>
    </TraceNest>
  );
}

function EditedFileHint({
  record,
  onOpen,
}: {
  record: ChangeRecord;
  onOpen?: (record: ChangeRecord) => void;
}) {
  const verb =
    record.operation === 'write' ? 'Created' : record.operation === 'delete' ? 'Deleted' : 'Edited';
  const clickable = Boolean(onOpen);
  const fileName = record.fileName || record.filePath;

  const body = (
    <>
      <span className="text-[var(--text-muted)]/60">{verb}</span>
      <span
        className={`max-w-[28rem] truncate font-mono ${
          clickable ? 'text-[var(--accent)] group-hover:underline' : 'text-[var(--text-secondary)]'
        }`}
      >
        {fileName}
      </span>
      {record.addedLines + record.removedLines > 0 ? (
        <DiffStatLabel additions={record.addedLines} deletions={record.removedLines} />
      ) : null}
    </>
  );

  if (clickable) {
    return (
      <button
        type="button"
        onClick={() => onOpen?.(record)}
        title={record.filePath}
        className="group ml-0.5 mt-0.5 inline-flex items-baseline gap-1.5 text-left text-[11px] leading-5 transition-opacity"
      >
        {body}
      </button>
    );
  }
  return (
    <div
      title={record.filePath}
      className="ml-0.5 mt-0.5 inline-flex items-baseline gap-1.5 text-[11px] leading-5"
    >
      {body}
    </div>
  );
}

// ── Tool detail (args / output / diff), shown when row is expanded ──────────

function hasEntryDetail(
  entry: Extract<WorkstreamEntry, { type: 'tool' | 'task' | 'memory' }>
): boolean {
  const inputRecord = isRecord(entry.block.input) ? getPublicToolInput(entry.block.input) : {};
  return Boolean(
    entry.detail || entry.result || ('liveOutput' in entry && entry.liveOutput) || Object.keys(inputRecord).length
  );
}

function ToolEntryDetail({
  entry,
}: {
  entry: Extract<WorkstreamEntry, { type: 'tool' | 'task' | 'memory' }>;
}) {
  const inputRecord = isRecord(entry.block.input) ? getPublicToolInput(entry.block.input) : {};
  const contentStr = ('liveOutput' in entry && entry.liveOutput) || entry.result?.displayContent || entry.result?.content || entry.detail || '';
  const diffContent =
    entry.toolName === 'Write' || entry.toolName === 'Edit' || entry.toolName === 'Delete'
      ? getToolResultDiffContent(entry.result)
      : null;
  const diffFilePath =
    (diffContent ? extractUnifiedDiffFilePath(diffContent) : null) || getToolInputFilePath(inputRecord);
  const diffHunks = useMemo(() => {
    if (diffContent) {
      return parseUnifiedDiff(diffContent);
    }
    if (entry.toolName === 'Edit') {
      const oldText = getToolInputOldText(inputRecord);
      const newText = getToolInputNewText(inputRecord);
      if (oldText !== null && newText !== null) {
        return createUnifiedDiffHunks(oldText, newText, { contextLines: 3 });
      }
    }
    if (entry.toolName === 'Write') {
      const content = getToolInputContent(inputRecord);
      if (content) {
        return buildWritePreviewHunks(content);
      }
    }
    return [];
  }, [diffContent, entry.toolName, inputRecord]);

  return (
    <div className="my-1 space-y-2 text-[12px]">
      {entry.result?.images?.length ? <AttachmentPreviewGrid attachments={entry.result.images} align="start" /> : null}
      {entry.result?.mediaRefs && entry.result.mediaRefs.length > 0 ? (
        <ComputerUseScreenshots refs={entry.result.mediaRefs} />
      ) : null}
      {diffHunks.length > 0 ? (
        <div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
            {diffFilePath || entry.summary}
          </div>
          <div className="overflow-hidden border border-[var(--border)]/45 bg-[var(--bg-secondary)]/35">
            <div className="max-h-72 overflow-auto">
              {diffHunks.map((hunk, index) => (
                <DiffHunkView key={`${hunk.oldStart}-${hunk.newStart}-${index}`} hunk={hunk} />
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <ToolResultContent
        content={contentStr}
        pending={entry.status === 'pending' || Boolean(entry.result?.images?.length || entry.result?.mediaRefs?.length)}
        isError={entry.status === 'error'}
        raw={{ callId: entry.block.id, invocation: { tool: entry.toolName, arguments: inputRecord }, result: entry.result ?? null }}
      />
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getPublicToolInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !key.startsWith('__aegis'))
  );
}

function truncateWithNotice(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars).trimEnd()}\n\n[Output truncated by Aegis: ${omitted.toLocaleString()} characters hidden]`;
}

function safeTitle(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return truncateWithNotice(value, MAX_TITLE_CHARS);
}

function buildWritePreviewHunks(content: string): UnifiedDiffHunk[] {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines: lines.map((line, index) => ({
        type: 'addition',
        oldLineNumber: null,
        newLineNumber: index + 1,
        text: line,
      })),
    },
  ];
}

// ── Idle activity label (used when no current tool owns the status) ─────────

export function WorkingFooter({ label = 'Working' }: { label?: string }) {
  return (
    <div className="trace-text my-2 text-[var(--text-muted)]">
      <WorkstreamActivityLabel active>{label}</WorkstreamActivityLabel>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

// ── Response divider ("Response · Worked for Xs") ───────────────────────────

export function ResponseDivider({ durationMs }: { durationMs: number | undefined }) {
  const elapsed = typeof durationMs === 'number' ? formatElapsed(durationMs) : null;
  return (
    <div className="my-4 flex items-center gap-3 px-1">
      <div className="h-px flex-1 bg-[var(--border)]/60" />
      <span className="text-[11px] tracking-[0.04em] text-[var(--text-muted)]/80">
        Response{elapsed ? ` · Worked for ${elapsed}` : ''}
      </span>
      <div className="h-px flex-1 bg-[var(--border)]/60" />
    </div>
  );
}

// Re-export utility types for callers that import alongside.
export type { ToolResultBlock, ToolUseBlock };

/** A background task that ended mid-turn, at its place in the trace. */
function BackgroundTaskEndedEntryRow({ entry }: { entry: Extract<WorkstreamEntry, { type: 'backgroundTaskEnded' }> }) {
  const sessionId = useContext(ImageStudioSessionContext);
  return <BackgroundTaskEndedRow sessionId={sessionId} outcome={entry.outcome} />;
}
