import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileAnchor } from "../scripts/anchor-artifact";

const committed = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "contracts", "AuditAnchor.json"), "utf8"));

describe("the anchor contract (B1)", () => {
  it("compiles reproducibly to the committed artifact", () => {
    const fresh = compileAnchor();
    expect(fresh.compiler).toBe(committed.compiler);
    expect(fresh.sourceSha256).toBe(committed.sourceSha256);
    expect(fresh.bytecode).toBe(committed.bytecode);
    expect(fresh.deployedBytecode).toBe(committed.deployedBytecode);
    expect(fresh.abi).toEqual(committed.abi);
  }, 120_000);

  it("exposes only what the anchoring needs: anchor, anchoredAt, the event and the error", () => {
    const names = committed.abi.map((item: { type: string; name: string }) => `${item.type}:${item.name}`).sort();
    expect(names).toEqual(["error:AlreadyAnchored", "event:Anchored", "function:anchor", "function:anchoredAt"]);
    const source = fs.readFileSync(path.resolve(__dirname, "..", "contracts", "AuditAnchor.sol"), "utf8").replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/owner|Ownable|upgrade|selfdestruct|delegatecall/i);
  });

  it("targets the paris EVM, so it runs on any current EVM chain", () => {
    expect(committed.settings).toEqual({ optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" });
    // PUSH0 (0x5f) arrived after paris; its absence from the opcode stream is what makes the bytecode portable.
    expect(committed.compiler).toMatch(/^0\.8\.37\+/);
  });
});
