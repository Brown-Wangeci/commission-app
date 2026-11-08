"""Independent reference implementation of Ledgerfield's audit hashing.

Written from the specification in docs/chapter5/audit-chain.md, not from the
TypeScript or SQL code, to show the hashes are reproducible in another
language. Reads the vectors file named on the command line, recomputes every
canonical form, event hash, Merkle root and inclusion proof, and prints a JSON
report. Exits 0 only if every value matches.

Usage: python audit_reference.py docs/chapter5/audit-chain-vectors.json
Standard library only.
"""
import hashlib
import json
import sys

KEYS = ["activationId", "actorId", "at", "detail", "fromState", "id", "kind", "previousHash", "sequence", "toState", "version"]


def canonical(event):
    """Keys in code point order, no whitespace, values JSON strings or null."""
    values = dict(event)
    values["version"] = "ledgerfield-audit-v1"
    parts = []
    for key in KEYS:
        value = values[key]
        encoded = "null" if value is None else json.dumps(value, ensure_ascii=False)
        parts.append(json.dumps(key) + ":" + encoded)
    return "{" + ",".join(parts) + "}"


def sha256(data):
    return hashlib.sha256(data).digest()


def leaf_hash(leaf_hex):
    return sha256(b"\x00" + bytes.fromhex(leaf_hex))


def node_hash(left, right):
    return sha256(b"\x01" + left + right)


def largest_power_of_two_below(n):
    k = 1
    while k * 2 < n:
        k *= 2
    return k


def merkle_root(leaves):
    """RFC 6962 section 2.1 Merkle tree hash."""
    if len(leaves) == 1:
        return leaf_hash(leaves[0])
    k = largest_power_of_two_below(len(leaves))
    return node_hash(merkle_root(leaves[:k]), merkle_root(leaves[k:]))


def verify_inclusion(leaf_hex, index, size, proof_hex, root_hex):
    """RFC 9162 section 2.1.3.2."""
    if index >= size:
        return False
    fn, sn, r = index, size - 1, leaf_hash(leaf_hex)
    for p in (bytes.fromhex(h) for h in proof_hex):
        if sn == 0:
            return False
        if fn % 2 == 1 or fn == sn:
            r = node_hash(p, r)
            while fn % 2 == 0 and fn != 0:
                fn //= 2
                sn //= 2
        else:
            r = node_hash(r, p)
        fn //= 2
        sn //= 2
    return sn == 0 and r.hex() == root_hex


def main(path):
    with open(path, encoding="utf-8") as handle:
        vectors = json.load(handle)
    report = {"events": [], "trees": [], "proofs": []}
    ok = True
    for vector in vectors["events"]:
        text = canonical(vector["input"])
        digest = sha256(text.encode("utf-8")).hex()
        match = text == vector["canonical"] and digest == vector["hash"]
        ok = ok and match
        report["events"].append({"sequence": vector["input"]["sequence"], "hash": digest, "matches": match})
    for tree in vectors["merkle"]["trees"]:
        root = merkle_root(tree["leaves"]).hex()
        match = root == tree["root"]
        ok = ok and match
        report["trees"].append({"size": len(tree["leaves"]), "root": root, "matches": match})
    for case in vectors["merkle"]["proofs"]:
        valid = verify_inclusion(case["leaf"], case["index"], case["size"], case["proof"], case["root"])
        ok = ok and valid
        report["proofs"].append({"index": case["index"], "valid": valid})
    report["ok"] = ok
    print(json.dumps(report))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
