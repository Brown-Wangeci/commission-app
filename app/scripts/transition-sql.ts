/**
 * Prints the INSERT statement for "ActivationTransitionRule" from the
 * transition table in src/lib/activations/states.ts. Used to write the
 * state-machine migration; tests/state-machine.test.ts checks that the
 * database table still matches the TypeScript table.
 *
 * Usage: npx tsx scripts/transition-sql.ts
 */
import { transitionPairs } from "../src/lib/activations/states";

const values = transitionPairs()
  .map(([from, to]) => `  ('${from}', '${to}')`)
  .join(",\n");
console.log(`INSERT INTO "ActivationTransitionRule" ("fromState", "toState") VALUES\n${values};`);
