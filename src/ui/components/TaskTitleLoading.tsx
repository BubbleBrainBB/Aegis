import { useEffect, useRef, useState } from 'react';

/** Where a task's title goes while its agent is still naming it. */
export function TaskTitleLoading({ className = '' }: { className?: string }) {
  return <span role="status" aria-label="Naming task" data-title-loading className={`task-title-loading ${className}`} />;
}

/** The class that fades a title in once its agent has named the task (none for a title that was always there). */
export function useTaskTitleReveal(pending: boolean | undefined): string {
  const wasPending = useRef(pending);
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    if (wasPending.current && !pending) setReveal(true);
    wasPending.current = pending;
  }, [pending]);
  return reveal ? 'task-title-reveal' : '';
}
