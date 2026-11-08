/**
 * Compiles contracts/AuditAnchor.sol with the pinned solc-js and writes the
 * ABI and bytecode to contracts/AuditAnchor.json, which the app loads. The
 * output is deterministic for a given source and settings; the test suite
 * recompiles and checks the committed artifact matches.
 *
 * EVM version "paris" (no PUSH0) is chosen so the same bytecode runs on any
 * current EVM chain, local nodes and Polygon Amoy alike.
 *
 * Usage: npm run contract:compile
 */
import fs from "node:fs";
import path from "node:path";
import { compileAnchor } from "./anchor-artifact";

const out = path.resolve(__dirname, "..", "contracts", "AuditAnchor.json");
fs.writeFileSync(out, `${JSON.stringify(compileAnchor(), null, 2)}\n`);
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
