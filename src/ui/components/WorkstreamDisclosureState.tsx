import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type TurnChoices = Record<string, boolean>;
/** A stored choice and when it was made, so the latest wins across a run's names. */
type StoredChoice = { expanded: boolean; order: number };
type StoredTurn = Record<string, StoredChoice>;
interface Registry {
  turns: Record<string, StoredTurn>;
  setChoice: (turn: string, key: string, expanded: boolean) => void;
}
const RegistryContext = createContext<Registry | null>(null);
const Context = createContext<{ choices: TurnChoices; setChoice: (key: string, expanded: boolean) => void } | null>(null);
const emptyTurn: TurnChoices = {};

/** Lives above timeline reconciliation; a streaming group may remount at final answer. */
export function WorkstreamDisclosureRegistry({ children }: { children: ReactNode }) {
  const [turns, setTurns] = useState<Record<string, StoredTurn>>({});
  const writes = useRef(0);
  const setChoice = useCallback((turn: string, key: string, expanded: boolean) => {
    writes.current += 1;
    const order = writes.current;
    setTurns(previous => ({ ...previous, [turn]: { ...previous[turn], [key]: { expanded, order } } }));
  }, []);
  const value = useMemo(() => ({ turns, setChoice }), [turns, setChoice]);
  return <RegistryContext.Provider value={value}>{children}</RegistryContext.Provider>;
}

/**
 * The choices of every scope in `names`, the most recent write winning. A run
 * keeps several names as history pages in (see workDisclosureScope), and a
 * choice made under any of them still applies.
 */
export function resolveScopedChoices(turns: Record<string, StoredTurn>, names: readonly string[]): TurnChoices {
  const latest: Record<string, StoredChoice> = {};
  for (const name of names) {
    const stored = turns[name];
    if (!stored) continue;
    for (const [key, choice] of Object.entries(stored)) {
      if (!latest[key] || choice.order > latest[key].order) latest[key] = choice;
    }
  }
  const keys = Object.keys(latest);
  if (keys.length === 0) return emptyTurn;
  return Object.fromEntries(keys.map((key) => [key, latest[key].expanded]));
}

/**
 * Owned by the turn, outside lazily mounted activity details. Choices are
 * written under `scopeKey`; ones stored under `aliasKeys` (other names of the
 * same run) are read too, the most recent winning.
 */
export function WorkstreamDisclosureState({
  children,
  scopeKey,
  aliasKeys,
}: {
  children: ReactNode;
  scopeKey?: string | number | null;
  aliasKeys?: readonly string[];
}) {
  const registry = useContext(RegistryContext);
  const [local, setLocal] = useState<TurnChoices>(emptyTurn);
  const scope = scopeKey == null ? null : String(scopeKey);
  const turns = registry?.turns;
  const registered = useMemo(
    () => (turns && scope != null ? resolveScopedChoices(turns, [scope, ...(aliasKeys ?? [])]) : null),
    [aliasKeys, scope, turns]
  );
  const choices = registered ?? local;
  const setChoice = (key: string, expanded: boolean) => {
    if (registry && scope != null) registry.setChoice(scope, key, expanded);
    else setLocal(previous => ({ ...previous, [key]: expanded }));
  };
  return <Context.Provider value={{ choices, setChoice }}>{children}</Context.Provider>;
}

export function useWorkstreamDisclosureActions() {
  return useContext(Context)?.setChoice;
}

export function useWorkstreamDisclosure(key: string, defaultExpanded = false) {
  const context = useContext(Context);
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const expanded = (context?.choices ?? local)[key] ?? defaultExpanded;
  const setExpanded = (value: boolean) => {
    if (context) context.setChoice(key, value);
    else setLocal(previous => ({ ...previous, [key]: value }));
  };
  return [expanded, setExpanded] as const;
}
