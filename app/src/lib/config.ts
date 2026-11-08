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
  MPESA_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  MPESA_BASE_URL: z.string().url().optional(),
  MPESA_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  MPESA_STK_TRANSACTION_TYPE: z.enum(["CustomerPayBillOnline", "CustomerBuyGoodsOnline"]).default("CustomerPayBillOnline"),
  MPESA_B2C_COMMAND_ID: z.enum(["BusinessPayment", "SalaryPayment", "PromotionPayment"]).default("BusinessPayment"),
  MPESA_WHOLE_SHILLINGS_ONLY: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  MPESA_STK_MIN_CENTS: z.coerce.number().int().positive().default(100),
  MPESA_STK_MAX_CENTS: z.coerce.number().int().positive().default(25_000_000),
  MPESA_B2C_MIN_CENTS: z.coerce.number().int().positive().default(1_000),
  MPESA_B2C_MAX_CENTS: z.coerce.number().int().positive().default(25_000_000),
  MPESA_CALLBACK_ALLOWED_IPS: z.string().default(""),
  MPESA_CAPTURE_DIR: z.string().optional(),
  PAYMENT_RETRY_BASE_SECONDS: z.coerce.number().int().positive().default(60),
  PAYMENT_MAX_SENDS: z.coerce.number().int().min(1).max(50).default(6),
  PAYMENT_RESULT_WAIT_SECONDS: z.coerce.number().int().positive().default(900),
  PAYMENT_MAX_STATUS_QUERIES: z.coerce.number().int().min(1).max(50).default(3),
  FUNDING_RETRY_BASE_SECONDS: z.coerce.number().int().positive().default(15),
  FUNDING_MAX_SENDS: z.coerce.number().int().min(1).max(50).default(3),
  FUNDING_RESULT_WAIT_SECONDS: z.coerce.number().int().positive().default(180),
  FUNDING_MAX_STATUS_QUERIES: z.coerce.number().int().min(1).max(50).default(3),
  ANCHOR_INTERVAL_SECONDS: z.coerce.number().int().positive().default(3600),
  ANCHOR_MAX_LEAVES: z.coerce.number().int().min(1).max(100_000).default(5000),
  ANCHOR_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(6),
  ANCHOR_RETRY_BASE_SECONDS: z.coerce.number().int().positive().default(60),
  ANCHOR_RECEIPT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  ANCHOR_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  POLYGON_EXPLORER_URL: z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional()),
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
