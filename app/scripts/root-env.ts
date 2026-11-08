import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * The M-Pesa and Polygon credentials live in the .env at the repository root,
 * which Next.js and Prisma do not read: they read app/.env. This copies only
 * the MPESA_ and POLYGON_ names from the root file, so nothing else there can
 * change how the app behaves, and it never replaces a value already set.
 *
 * Called from next.config.ts and scripts/load-env.ts. Deliberately not called
 * by the test suite, which must never see real credentials or reach Daraja or
 * a blockchain.
 */
const PREFIXES = ["MPESA_", "POLYGON_"];

export function loadRootEnv(appDir: string): void {
  const file = path.resolve(appDir, "..", ".env");
  if (!fs.existsSync(file)) return;
  for (const [name, value] of Object.entries(parseEnv(fs.readFileSync(file, "utf8")))) {
    if (PREFIXES.some((prefix) => name.startsWith(prefix)) && process.env[name] === undefined) process.env[name] = value;
  }
}
