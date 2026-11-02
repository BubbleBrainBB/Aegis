import { useEffect, useState } from 'react';
import { ChevronRight, LoaderCircle, ShieldAlert } from './icons';
import { useWorkstreamDisclosure } from './WorkstreamDisclosureState';
import { WorkstreamActivityLabel, WorkstreamCollapse, WorkstreamElapsed, formatWorkstreamElapsed } from './WorkstreamPrimitives';
import { getWorkstreamStepCommand } from '../utils/workstream-stages';
import { getTurnActivity, STILL_THINKING_MS } from '../utils/live-trace';
import type { WorkstreamModel } from '../utils/workstream';

const OUTPUT_TAIL_LINES = 4;

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function outputTail(output: string | undefined): string {
  return output?.trimEnd().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n') ?? '';
}

/** A running turn's activity at its end: what it is doing and for how long, opening onto the current step. */
export function TurnStatusLine({ model }: { model: WorkstreamModel }) {
  const now = useNow();
  const activity = getTurnActivity(model.entries);
  const activityKey = activity.kind === 'step' ? `step:${activity.step.id}` : `${activity.kind}:${activity.label}`;
  const [since, setSince] = useState({ key: activityKey, at: now });
  if (since.key !== activityKey) setSince({ key: activityKey, at: Date.now() });
  const label = activity.kind === 'idle' && activity.label === 'Thinking…' && since.key === activityKey && now - since.at >= STILL_THINKING_MS
    ? 'Still thinking…'
    : activity.label;
  const step = activity.kind === 'step' ? activity.step : null;
  const command = step ? getWorkstreamStepCommand(step) : null;
  const output = step && step.type === 'tool' ? outputTail(step.liveOutput) : '';
  const canOpen = Boolean(command || output);
  const [open, setOpen] = useWorkstreamDisclosure('turn-status-step', false);
  const elapsed = model.startedAt != null && now - model.startedAt >= 1000 ? formatWorkstreamElapsed(now - model.startedAt) : null;
  const waiting = activity.kind === 'waiting';
  // The retry banner reports a stalled stream itself.
  if (model.retrying) return null;

  return (
    <div className="turn-status" data-turn-status>
      <WorkstreamCollapse open={open && canOpen}>
        {step && canOpen ? (
          <div className="turn-step-panel" data-turn-step-panel>
            <div className="turn-step-head">
              <span className="turn-step-title">{label}</span>
              {command && command !== label ? <code className="turn-step-command">{command}</code> : null}
              <span className="turn-step-elapsed"><WorkstreamElapsed startedAt={step.execution?.startedAt} running /></span>
            </div>
            {output ? <pre className="turn-step-output">{output}</pre> : null}
          </div>
        ) : null}
      </WorkstreamCollapse>
      <button
        type="button"
        className="turn-status-line"
        data-tone={waiting ? 'waiting' : undefined}
        aria-expanded={canOpen ? open : undefined}
        disabled={!canOpen}
        onClick={() => setOpen(!open)}
      >
        <span className="turn-status-icon" aria-hidden="true">{waiting ? <ShieldAlert /> : <LoaderCircle className="animate-spin" />}</span>
        <WorkstreamActivityLabel active activityKey={activityKey}>{label}</WorkstreamActivityLabel>
        {elapsed ? <span className="turn-status-meta">· {elapsed}</span> : null}
        {canOpen ? <ChevronRight className={`turn-status-caret ${open ? 'rotate-90' : '-rotate-90'}`} aria-hidden="true" /> : null}
      </button>
    </div>
  );
}
