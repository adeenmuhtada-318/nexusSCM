/**
 * Tiny pure helper for explicit status transition maps (CLAUDE.md §5: "All statuses are enums with an
 * explicit transition map in rules.ts"). Illegal transitions return an error and are never written.
 */
export type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

export type TransitionResult<S extends string> =
  | { ok: true; to: S }
  | { ok: false; error: string };

export function canTransition<S extends string>(map: TransitionMap<S>, from: S, to: S): boolean {
  return map[from].includes(to);
}

export function checkTransition<S extends string>(map: TransitionMap<S>, from: S, to: S): TransitionResult<S> {
  return canTransition(map, from, to)
    ? { ok: true, to }
    : { ok: false, error: `Illegal transition ${from} → ${to}` };
}

/** Terminal states = those with no outgoing transitions. */
export function isTerminal<S extends string>(map: TransitionMap<S>, s: S): boolean {
  return map[s].length === 0;
}
