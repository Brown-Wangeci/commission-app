/**
 * Fails the build if any Float or Decimal column could hold money (issue
 * #40). Run by `npm run build` before anything is compiled, and by
 * `npm run check:money` on its own. The rules are in
 * src/lib/money/schema-check.ts. An optional argument checks another schema
 * file instead.
 */
import fs from "node:fs";
import path from "node:path";
import { moneyColumnViolations } from "../src/lib/money/schema-check";

const schemaPath = path.resolve(process.argv[2] ?? path.join(__dirname, "../prisma/schema.prisma"));
const violations = moneyColumnViolations(fs.readFileSync(schemaPath, "utf8"));

if (violations.length > 0) {
  console.error(`Money column check failed for ${schemaPath}:`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}
console.log("Money column check passed: no Float or Decimal column holds money, and every money column is integer cents.");
