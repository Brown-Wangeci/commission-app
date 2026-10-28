import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { resetDatabase } from "./helpers/db";
import { submitReady } from "./helpers/submission";

/**
 * Runs against the real scoring service at LIVE_SCORING_URL (default
 * http://127.0.0.1:8000) and is skipped when it is not running. It checks the
 * app's request is accepted by the real service and that whatever thresholds
 * the service reports are the ones stored.
 */
const liveUrl = process.env.LIVE_SCORING_URL ?? "http://127.0.0.1:8000";

async function serviceIsUp(): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", liveUrl), { signal: AbortSignal.timeout(2000) });
    const body = (await response.json()) as { loaded?: boolean };
    return response.ok && body.loaded === true;
  } catch {
    return false;
  }
}

const up = await serviceIsUp();
let previousUrl: string | undefined;

beforeAll(async () => {
  previousUrl = process.env.SCORING_SERVICE_URL;
  process.env.SCORING_SERVICE_URL = liveUrl;
  await resetDatabase();
});
afterAll(() => {
  process.env.SCORING_SERVICE_URL = previousUrl;
});

describe.runIf(up)("live scoring service", () => {
  it("accepts a T0 request built by the app and returns the T0 model's thresholds", async () => {
    const result = await submitReady();
    expect(result.scoring).toBe("scored");
    const decision = await prisma.scoringDecision.findFirstOrThrow({
      where: { activationId: result.activationId },
      include: { reasons: true },
    });
    const health = (await (await fetch(new URL("/health", liveUrl))).json()) as { t0_model_version: string };
    expect(decision.mode).toBe("t0");
    expect(decision.modelVersion).toBe(health.t0_model_version);
    expect(decision.releaseThreshold).toBeLessThan(decision.rejectThreshold);
    expect(decision.reasons.length).toBeGreaterThan(0);
    expect(["held", "in_review"]).toContain(result.state);
  });
});
