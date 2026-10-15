import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type TurnChoices = Record<string, boolean>;
interface Registry {
  turns: Record<string, TurnChoices>;
  setChoice: (turn: string, key: string, expanded: boolean) => void;
}
const RegistryContext = createContext<Registry | null>(null);
const Context = createContext<{ choices: TurnChoices; setChoice: (key: string, expanded: boolean) => void } | null>(null);
const emptyTurn: TurnChoices = {};

/** Lives above timeline reconciliation; a streaming group may remount at final answer. */
export function WorkstreamDisclosureRegistry({ children }: { children: ReactNode }) {
  const [turns, setTurns] = useState<Record<string, TurnChoices>>({});
  const setChoice = useCallback((turn: string, key: string, expanded: boolean) => {
    setTurns(previous => ({ ...previous, [turn]: { ...(previous[turn] ?? emptyTurn), [key]: expanded } }));
  }, []);
  return <RegistryContext.Provider value={{ turns, setChoice }}>{children}</RegistryContext.Provider>;
}

/** Owned by the turn, outside lazily mounted activity details. */
export function WorkstreamDisclosureState({ children, scopeKey }: { children: ReactNode; scopeKey?: string | number | null }) {
  const registry = useContext(RegistryContext);
  const [local, setLocal] = useState<TurnChoices>(emptyTurn);
  const scope = scopeKey == null ? null : String(scopeKey);
  const choices = registry && scope != null ? registry.turns[scope] ?? emptyTurn : local;
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
