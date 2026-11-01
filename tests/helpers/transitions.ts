import { expect } from "vitest";
import type { TransitionResult } from "@/lib/utils/state-machine";

/**
 * Exhaustive transition test: for EVERY (from,to) pair of the status set, the check must accept exactly the
 * pairs listed independently here as `legal` and reject all others (CLAUDE.md §6).
 */
export function expectExactTransitions<S extends string>(
  statuses: readonly S[],
  legal: ReadonlyArray<readonly [S, S]>,
  check: (from: S, to: S) => TransitionResult<S>,
): void {
  const legalSet = new Set(legal.map(([a, b]) => `${a}>${b}`));
  let illegalCount = 0;
  for (const from of statuses) {
    for (const to of statuses) {
      const res = check(from, to);
      const expected = legalSet.has(`${from}>${to}`);
      expect(res.ok, `${from} → ${to}`).toBe(expected);
      if (!expected) {
        illegalCount++;
        expect(res.ok === false && res.error.length > 0).toBe(true);
      }
    }
  }
  expect(illegalCount).toBe(statuses.length * statuses.length - legal.length);
}
