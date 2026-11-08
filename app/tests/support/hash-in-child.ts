// Run in a fresh process by tests/audit-chain.test.ts: prints the hashes of
// the published vectors, computed with nothing shared with the test process.
import fs from "node:fs";
import { auditEventHash } from "../../src/lib/audit/canonical";

type Vector = { input: Record<string, string | null> };
const vectors = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as { events: Vector[] };
const hashes = vectors.events.map(({ input }) =>
  auditEventHash(
    { id: input.id!, kind: input.kind!, activationId: input.activationId, fromState: input.fromState, toState: input.toState, actorId: input.actorId, detail: input.detail, at: new Date(input.at!) },
    input.sequence!,
    input.previousHash!,
  ),
);
console.log(JSON.stringify(hashes));
