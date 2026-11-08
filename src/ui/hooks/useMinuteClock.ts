import { useSyncExternalStore } from 'react';

// One timer for every relative age on screen ("2m", "3h"), however many rows show one.
let now = Date.now();
const listeners = new Set<() => void>();
let timer: number | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The current time, moving on once a minute: enough for ages shown in minutes or coarser. */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, () => now);
}
