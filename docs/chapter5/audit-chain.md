# Audit chain and anchoring: specification

This is the contract for Ledgerfield's audit hashes (NFR-11). An implementation
in any language is correct when it reproduces every expected value in
[`audit-chain-vectors.json`](audit-chain-vectors.json) from the inputs there.
Three implementations do: PostgreSQL (`ledgerfield_audit_canonical()` in
migration `20261108090000_audit_chain_and_payout_hold`), TypeScript
(`app/src/lib/audit/canonical.ts` and `merkle.ts`), and an independent Python
reference written from this document (`app/scripts/audit_reference.py`). The
test suite checks all three against the vectors.

## 1. The event

An audit event has these fields, as stored in `AuditEvent`:

| Field | Type | Notes |
|---|---|---|
| `id` | integer | Row id. Written as a decimal string. |
| `kind` | text | `transition`, `scoring_decision`, `payout_authorised`, ... |
| `activationId` | text or null | The submission it concerns, if any. |
| `fromState`, `toState` | text or null | For state transitions. |
| `actorId` | text or null | The user who acted; null for the system. |
| `detail` | text or null | Free text. |
| `at` | timestamp | UTC, millisecond precision. |

Two more values come from its place in the chain:

| Value | Notes |
|---|---|
| `sequence` | 1 for the first event, then 1, 2, 3, ... in commit order, with no gaps. Decimal string. |
| `previousHash` | The hash of the event at `sequence - 1`. For the first event, 64 zeros. |

## 2. Canonical form

The canonical form is a JSON object with exactly these eleven keys, in this
order (Unicode code point order), with no whitespace anywhere:

```
activationId, actorId, at, detail, fromState, id, kind, previousHash, sequence, toState, version
```

- Every value is a JSON string or `null`. Nothing is a JSON number or boolean.
- `at` is written `YYYY-MM-DDTHH:MM:SS.sssZ`, in UTC, with exactly three
  millisecond digits.
- `id` and `sequence` are decimal strings, without leading zeros.
- `version` is the string `ledgerfield-audit-v1`.
- Strings are escaped as JSON requires and no further: `"` as `\"`, `\` as `\\`,
  the characters U+0008, U+000C, U+000A, U+000D, U+0009 as `\b \f \n \r \t`, any
  other character below U+0020 as `\u00xx` with lowercase hexadecimal digits.
  Every other character, including `/`, DEL, U+2028, U+2029 and everything
  outside ASCII, is written as itself. This is exactly what JavaScript's
  `JSON.stringify`, Python's `json.dumps(..., ensure_ascii=False)` and
  PostgreSQL's `to_json(text)` produce.

Example (vector 1):

```
{"activationId":"act_001","actorId":"user_agent_1","at":"2026-11-08T05:43:45.558Z","detail":null,"fromState":null,"id":"1","kind":"transition","previousHash":"0000000000000000000000000000000000000000000000000000000000000000","sequence":"1","toState":"submitted","version":"ledgerfield-audit-v1"}
```

## 3. Event hash and the chain

```
hash = lowercase hexadecimal SHA-256 of the UTF-8 bytes of the canonical form
```

Because the canonical form contains `previousHash`, each hash commits to every
event before it. Changing any stored field of any event changes that event's
recomputed hash, which no longer matches the next event's `previousHash`.

The database writes each event's link (sequence, previous hash, hash) in table
`AuditChain`, from a deferred trigger that runs when the event's transaction
commits. Taking the chain's lock at commit, rather than at insert, means no
transaction can hold it while waiting for any other lock. The event row itself
is never updated, and neither table can be updated or deleted (DR-09). An event
in a transaction that rolls back is never chained, so the chain has no gaps.

## 4. Batches and the Merkle root

Events are anchored in batches: a contiguous range of sequences, from the event
after the previous batch to the newest event (at most `ANCHOR_MAX_LEAVES`),
cut no more often than every `ANCHOR_INTERVAL_SECONDS`.

The root of a batch is the Merkle tree hash of RFC 6962 section 2.1, over the
batch's event hashes in sequence order, each taken as 32 raw bytes:

```
leaf hash  = SHA-256(0x00 || event hash)
node hash  = SHA-256(0x01 || left || right)
MTH(D[1])  = leaf hash of the one leaf
MTH(D[n])  = node hash(MTH(D[0:k]), MTH(D[k:n])), k the largest power of two below n
```

An event's inclusion proof is its audit path, RFC 6962 section 2.1.1, checked
with the algorithm in RFC 9162 section 2.1.3.2.

## 5. The contract

`app/contracts/AuditAnchor.sol`, compiled with solc 0.8.37, optimiser on (200
runs), EVM version paris. The compiled artifact is
`app/contracts/AuditAnchor.json`, and a test recompiles it and checks it
matches.

```
anchoredAt(bytes32 root) -> uint256    Unix time the root was recorded, 0 if never
anchor(bytes32 root)                   records it; reverts AlreadyAnchored if it exists
event Anchored(bytes32 indexed root, uint256 timestamp, address indexed submitter)
```

A root can be recorded once, so its time cannot be rewritten, and sending a
root twice can never create a second record. The anchoring queue relies on
this: before every attempt it asks the contract whether the root is already
there.

## 6. Verifying a submission's record

To verify independently of Ledgerfield's database:

1. For each event, recompute its hash from its fields (section 3) and check it
   equals the stored hash, and that its `previousHash` is the stored hash of
   the event before it.
2. For the batch each event falls in, recompute every leaf from stored fields,
   rebuild the root (section 4), and rebuild the event's inclusion proof.
3. Call `anchoredAt(root)` on the contract. A non-zero answer means the chain
   recorded exactly this root. Fetch the receipt of the batch's transaction and
   check its `Anchored` event carries the same root, at the recorded block.

If anyone changes an event after its batch was anchored, step 1 fails for that
event. If they also rewrite every later stored hash so the chain is
consistent again, step 3 fails: the root the stored events produce is not the
root the contract recorded before the change.

## 7. Limits

- A batch confirms on its first receipt; there is no wait for further blocks.
- Anyone can call `anchor()`. That cannot make a forged record verify: the
  verifier asks whether the root Ledgerfield's own events produce is on chain,
  and reports who submitted it.
- Events are anchored in batches, so a recent event can be chained but not yet
  anchored. Verification says so rather than failing.
