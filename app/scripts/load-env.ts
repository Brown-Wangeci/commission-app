import fs from "node:fs";
import path from "node:path";
import { loadRootEnv } from "./root-env";

/**
 * Loads app/.env for command-line scripts (Next.js and Prisma load it
 * themselves), then the MPESA_ and POLYGON_ names from the .env at the repository root.
 * Variables already set in the environment win, so a caller can point a
 * script at another database without editing the file.
 */
export function loadEnv(): void {
  const appDir = path.resolve(__dirname, "..");
  const file = path.join(appDir, ".env");
  if (fs.existsSync(file)) process.loadEnvFile(file);
  loadRootEnv(appDir);
}
