import { config } from "@/lib/config";
import { scoreResponseSchema, type ScoreRequestPayload, type ScoreResponse } from "./contract";

/**
 * HTTP client for POST /score. Never throws for a scoring problem: every
 * outcome is a CallResult, so a failure can be recorded and routed rather
 * than lost.
 */
export type FailureKind =
  | "timeout"
  | "unavailable"
  | "server_error"
  | "rejected_request"
  | "invalid_response"
  | "missing_input";

export type CallResult =
  | { ok: true; response: ScoreResponse; durationMs: number }
  | { ok: false; kind: FailureKind; message: string; durationMs: number; status?: number };

/** Failures worth retrying straight away. A rejected request will fail the same way again. */
export function isRetryable(kind: FailureKind): boolean {
  return kind === "timeout" || kind === "unavailable" || kind === "server_error" || kind === "invalid_response";
}

function failure(kind: FailureKind, message: string, started: number, status?: number): CallResult {
  return { ok: false, kind, message: message.slice(0, 1000), durationMs: Date.now() - started, status };
}

async function readDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    return typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
  } catch {
    return text || response.statusText;
  }
}

function classifyThrown(error: unknown, started: number): CallResult {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return failure("timeout", `no response within ${config().SCORING_TIMEOUT_MS} ms`, started);
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  return failure("unavailable", `could not reach the scoring service${cause ? `: ${cause}` : ""}`, started);
}

export async function callScoringOnce(payload: ScoreRequestPayload): Promise<CallResult> {
  const { SCORING_SERVICE_URL, SCORING_TIMEOUT_MS } = config();
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(new URL("/score", SCORING_SERVICE_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SCORING_TIMEOUT_MS),
    });
  } catch (error) {
    return classifyThrown(error, started);
  }
  if (response.status >= 500) {
    return failure("server_error", `HTTP ${response.status}: ${await readDetail(response)}`, started, response.status);
  }
  if (!response.ok) {
    return failure("rejected_request", `HTTP ${response.status}: ${await readDetail(response)}`, started, response.status);
  }
  return parseResponse(response, payload, started);
}

async function parseResponse(response: Response, payload: ScoreRequestPayload, started: number): Promise<CallResult> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failure("invalid_response", "the response was not JSON", started, response.status);
  }
  const parsed = scoreResponseSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return failure("invalid_response", `${first.path.join(".") || "body"}: ${first.message}`, started, response.status);
  }
  if (parsed.data.activation_id !== payload.activation.activation_id || parsed.data.mode !== payload.mode) {
    return failure("invalid_response", "the response is for a different activation or mode", started, response.status);
  }
  return { ok: true, response: parsed.data, durationMs: Date.now() - started };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Up to SCORING_IMMEDIATE_ATTEMPTS calls with doubling backoff. `onAttempt`
 * sees every call's result, so each failure can be recorded individually.
 */
export async function callScoringWithRetry(
  payload: ScoreRequestPayload,
  onAttempt: (result: CallResult) => Promise<void>,
): Promise<CallResult> {
  const { SCORING_IMMEDIATE_ATTEMPTS, SCORING_IMMEDIATE_BACKOFF_MS } = config();
  let result: CallResult = await callScoringOnce(payload);
  await onAttempt(result);
  for (let attempt = 2; attempt <= SCORING_IMMEDIATE_ATTEMPTS; attempt += 1) {
    if (result.ok || !isRetryable(result.kind)) break;
    await sleep(SCORING_IMMEDIATE_BACKOFF_MS * 2 ** (attempt - 2));
    result = await callScoringOnce(payload);
    await onAttempt(result);
  }
  return result;
}
