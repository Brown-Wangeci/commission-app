import fs from "node:fs";
import path from "node:path";

/**
 * Loads app/.env for command-line scripts (Next.js and Prisma load it
 * themselves). Variables already set in the environment win, so a caller
 * can point a script at another database without editing the file.
 */
export function loadEnv(): void {
  const file = path.resolve(__dirname, "..", ".env");
  if (fs.existsSync(file)) process.loadEnvFile(file);
}
