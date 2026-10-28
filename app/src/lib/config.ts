import { z } from "zod";

/**
 * Runtime configuration, read from environment variables only. Every
 * variable is documented in .env.example. Read on each call so tests and
 * scripts can change the environment between runs.
 */
const schema = z.object({
  SCORING_SERVICE_URL: z.string().url().default("http://127.0.0.1:8000"),
  SCORING_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  SCORING_IMMEDIATE_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  SCORING_IMMEDIATE_BACKOFF_MS: z.coerce.number().int().min(0).default(500),
  SCORING_RETRY_BASE_SECONDS: z.coerce.number().int().positive().default(60),
  SCORING_MAX_RUNS: z.coerce.number().int().min(1).max(50).default(6),
  HOLD_WINDOW_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 60 * 60),
  SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  SCHEDULER_LEASE_SECONDS: z.coerce.number().int().positive().default(120),
  CRON_SECRET: z.string().optional(),
  MSISDN_HASH_SALT: z.string().min(16, "MSISDN_HASH_SALT must be set to a long random string."),
  EVIDENCE_STORAGE_DIR: z.string().min(1).default("storage/evidence"),
  EVIDENCE_MAX_BYTES: z.coerce.number().int().positive().default(8_000_000),
});

export type AppConfig = z.infer<typeof schema>;

export function config(): AppConfig {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
  }
  return parsed.data;
}
