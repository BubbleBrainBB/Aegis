import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check } from './icons';
import type { AskUserQuestionInput, AskUserQuestion, PermissionResult, QuestionAnswerSelection } from '../types';

interface DecisionPanelProps {
  input: AskUserQuestionInput;
  onSubmit: (result: PermissionResult) => void;
  /** Who is asking, for the header ("Claude Code is asking"). */
  agentName?: string;
  /** Requests waiting behind this one (shown as 1/N when more than one). */
  pendingCount?: number;
}

const ACCENT_TINT = 'color-mix(in srgb, var(--accent) 9%, transparent)';

/**
 * The agent's questions, one at a time: the question, its options as compact
 * rows (with "Something else…" for a free answer), and Back / Next. Picking a
 * single-choice option moves on by itself; the last step sends every answer.
 * The accent follows the theme.
 */
export function DecisionPanel({ input, onSubmit, agentName = 'The agent', pendingCount = 1 }: DecisionPanelProps) {
  const questions = input.questions;
  const [step, setStep] = useState(0);
  // Picked option labels per question, kept as an array so a label may
  // itself contain commas.
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [otherInputs, setOtherInputs] = useState<Record<string, string>>({});
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const root = useRef<HTMLDivElement>(null);
  const otherField = useRef<HTMLInputElement>(null);
  const advance = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const question = questions[Math.min(step, questions.length - 1)];
  const key = question.question;
  const options = question.options ?? [];
  const last = step >= questions.length - 1;

  const answered = (q: AskUserQuestion) => !!(selections[q.question]?.length || otherInputs[q.question]?.trim());
  const isSelected = (label: string) => (selections[key] || []).includes(label);

  // Keys work as soon as the card shows, and on every step.
  useEffect(() => {
    if (!otherOpen[key]) root.current?.focus({ preventScroll: true });
  }, [step, key, otherOpen]);
  useEffect(() => () => clearTimeout(advance.current), []);
  useEffect(() => {
    if (otherOpen[key]) otherField.current?.focus();
  }, [otherOpen, key]);

  const goTo = (next: number) => {
    clearTimeout(advance.current);
    setStep(Math.max(0, Math.min(next, questions.length - 1)));
  };

  const pick = (label: string) => {
    if (question.multiSelect) {
      const current = selections[key] || [];
      setSelections({ ...selections, [key]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label] });
      return;
    }
    setSelections({ ...selections, [key]: [label] });
    // One answer per single-choice question: a pick replaces a typed one.
    setOtherOpen({ ...otherOpen, [key]: false });
    setOtherInputs({ ...otherInputs, [key]: '' });
    if (!last) {
      clearTimeout(advance.current);
      advance.current = setTimeout(() => setStep((s) => Math.min(s + 1, questions.length - 1)), 140);
    }
  };

  const toggleOther = () => {
    const open = !otherOpen[key];
    setOtherOpen({ ...otherOpen, [key]: open });
    if (!open) setOtherInputs({ ...otherInputs, [key]: '' });
    // A typed answer replaces the picked option for single choice.
    if (open && !question.multiSelect) setSelections({ ...selections, [key]: [] });
  };

  const submit = () => {
    // AskUserQuestion takes one comma-joined string per question (options,
    // then "Other" text); questionAnswers keeps the parts apart for adapters
    // that map labels back to option ids.
    const finalAnswers: Record<string, string> = {};
    const questionAnswers: Record<string, QuestionAnswerSelection> = {};
    for (const q of questions) {
      const selected = selections[q.question] || [];
      const other = otherInputs[q.question]?.trim() || '';
      if (selected.length === 0 && !other) continue;
      finalAnswers[q.question] = [...selected, ...(other ? [other] : [])].join(',');
      questionAnswers[q.question] = { selected, ...(other ? { other } : {}) };
    }
    onSubmit({ behavior: 'allow', updatedInput: { ...input, answers: finalAnswers }, questionAnswers });
  };

  const skip = () => onSubmit({ behavior: 'deny', message: 'User cancelled the request' });
  const next = () => {
    if (!answered(question)) return;
    if (last) submit();
    else goTo(step + 1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const typing = event.target instanceof HTMLInputElement;
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      next();
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (index < options.length) pick(options[index].label);
      else if (index === options.length) toggleOther();
      else return;
      event.preventDefault();
    } else if (event.key === 'ArrowLeft' && step > 0) {
      event.preventDefault();
      goTo(step - 1);
    } else if (event.key === 'ArrowRight' && !last && answered(question)) {
      event.preventDefault();
      goTo(step + 1);
    }
  };

  const keyBadge = (selected: boolean, label: string) => (
    <span
      aria-hidden="true"
      className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border text-[10.5px] font-medium tabular-nums"
      style={
        selected
          ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-foreground)' }
          : { borderColor: 'color-mix(in srgb, var(--text-primary) 16%, transparent)', color: 'var(--text-muted)' }
      }
    >
      {selected && question.multiSelect ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : label}
    </span>
  );

  return (
    <div
      ref={root}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-decision-panel
      className="flex flex-col overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--text-primary)_12%,transparent)] bg-[var(--bg-primary)] shadow-[0_8px_24px_rgba(15,23,42,0.08)] outline-none"
    >
      <div className="flex h-[38px] flex-none items-center gap-2 border-b border-[var(--border)] px-3.5 text-[12.5px] text-[var(--text-secondary)]">
        <span className="h-1.5 w-1.5 flex-none rounded-full bg-[var(--warning,#b26a00)]" aria-hidden="true" />
        <span className="min-w-0 truncate">
          <b className="font-semibold text-[var(--text-primary)]">{agentName}</b> is asking
        </span>
        <span className="flex-1" />
        {pendingCount > 1 ? (
          <span className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10.5px] tabular-nums text-[var(--text-secondary)]">1/{pendingCount}</span>
        ) : null}
        {questions.length > 1 ? (
          <>
            <span className="flex gap-1" aria-hidden="true">
              {questions.map((q, i) => (
                <i
                  key={i}
                  className="h-[3px] w-4 rounded-full"
                  style={{ background: i <= step ? 'var(--accent)' : 'color-mix(in srgb, var(--text-primary) 14%, transparent)', opacity: i < step && !answered(q) ? 0.45 : 1 }}
                />
              ))}
            </span>
            <span className="tabular-nums" data-decision-step>
              {step + 1} of {questions.length}
            </span>
          </>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-col gap-2.5 px-3.5 py-3">
        <div>
          {question.header ? <div className="text-[11.5px] text-[var(--text-muted)]">{question.header}</div> : null}
          <div className="text-[13.5px] font-semibold leading-normal text-[var(--text-primary)]" data-decision-question>
            {question.question}
          </div>
          {question.multiSelect ? <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">Pick any that apply</div> : null}
        </div>
        <div className="-mx-1 flex max-h-[min(46vh,320px)] flex-col gap-0.5 overflow-y-auto px-1" role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question}>
          {options.map((option, i) => {
            const selected = isSelected(option.label);
            return (
              <button
                key={i}
                type="button"
                role={question.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={selected}
                data-decision-option={i}
                onClick={() => pick(option.label)}
                className="flex min-h-[34px] w-full items-center gap-2.5 rounded-[7px] px-2 py-[5px] text-left text-[13px] transition-colors duration-100 hover:bg-[var(--bg-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
                style={selected ? { background: ACCENT_TINT } : undefined}
              >
                {keyBadge(selected, String(i + 1))}
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium text-[var(--text-primary)]">{option.label}</span>
                  {option.description ? <span className="text-[12px] leading-[1.45] text-[var(--text-muted)]">{option.description}</span> : null}
                </span>
              </button>
            );
          })}
          {otherOpen[key] ? (
            <div className="flex min-h-[34px] items-center gap-2.5 rounded-[7px] px-2 py-[5px]" style={{ background: ACCENT_TINT }}>
              {keyBadge(true, String(options.length + 1))}
              <input
                ref={otherField}
                type="text"
                data-decision-other
                value={otherInputs[key] || ''}
                onChange={(e) => setOtherInputs({ ...otherInputs, [key]: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleOther();
                    root.current?.focus();
                  }
                }}
                placeholder="Type your answer"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              />
            </div>
          ) : (
            <button
              type="button"
              data-decision-other-toggle
              onClick={toggleOther}
              className="flex min-h-[34px] w-full items-center gap-2.5 rounded-[7px] px-2 py-[5px] text-left text-[13px] text-[var(--text-secondary)] transition-colors duration-100 hover:bg-[var(--bg-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
            >
              {keyBadge(false, String(options.length + 1))}
              <span>Something else…</span>
            </button>
          )}
        </div>
      </div>

      <div className="flex h-11 flex-none items-center gap-2 border-t border-[var(--border)] pl-3.5 pr-2.5 text-[12.5px]">
        <button type="button" onClick={skip} className="h-7 rounded-[7px] px-2.5 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
          Skip
        </button>
        <span className="flex-1" />
        {step > 0 ? (
          <button
            type="button"
            onClick={() => goTo(step - 1)}
            className="h-7 rounded-[7px] border border-[color-mix(in_srgb,var(--text-primary)_14%,transparent)] px-2.5 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            Back
          </button>
        ) : null}
        <button
          type="button"
          data-decision-next
          onClick={next}
          disabled={!answered(question)}
          className="inline-flex h-7 items-center gap-1.5 rounded-[7px] px-3 font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
          style={{ background: 'var(--accent)', color: 'var(--accent-foreground)' }}
        >
          {last ? 'Send' : 'Next'}
          <span aria-hidden="true" className="text-[10.5px] opacity-70">↵</span>
        </button>
      </div>
    </div>
  );
}


// 生成问题签名（用于匹配 permission.request 和 tool_use）
export function getAskUserQuestionSignature(input: AskUserQuestionInput): string {
  return input.questions
    .map((q) => {
      const optionsStr = q.options
        ?.map((o) => `${o.label}|${o.description || ''}`)
        .join(';');
      return `${q.question}:${q.header || ''}:${q.multiSelect || false}:${optionsStr || ''}`;
    })
    .join('||');
}
