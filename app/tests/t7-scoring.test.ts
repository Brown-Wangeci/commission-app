import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { reportActivity } from "@/lib/activity/report";
import { forceT7 } from "@/lib/scoring/force";
import { runDueScoringJobs } from "@/lib/scoring/runner";
import { addWeekOfActivity } from "./helpers/activity";
import { resetDatabase } from "./helpers/db";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { createClient, createUser } from "./helpers/factories";
import { submitReady } from "./helpers/submission";

let fake: FakeScoring;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

beforeAll(async () => {
  fake = await startFakeScoring();
  process.env.SCORING_SERVICE_URL = fake.url;
});
afterAll(() => fake.close());
beforeEach(async () => {
  await resetDatabase();
  fake.requests.length = 0;
  process.env.HOLD_WINDOW_SECONDS = "604800";
});

/** A held activation with a week of reported activity; T7 replies with `band`. */
async function heldActivation(band: "auto_release" | "review" | "reject", probability: number) {
  fake.setHandler(replyWith("review", 0.4));
  const result = await submitReady();
  await addWeekOfActivity(result.activationId);
  fake.setHandler(replyWith(band, probability));
  return result.activationId;
}

const t7Requests = () => fake.requests.filter((request) => request.mode === "t7");

describe("T7 scoring at hold-close (issue #7)", () => {
  it("does nothing before the hold window closes", async () => {
    await heldActivation("auto_release", 0.05);
    const summary = await runDueScoringJobs(new Date());
    expect(summary.scored).toBe(0);
    expect(t7Requests()).toHaveLength(0);
  });

  it("scores with T7 features once the window closes and releases an auto_release", async () => {
    const id = await heldActivation("auto_release", 0.05);
    const summary = await runDueScoringJobs(new Date(Date.now() + WEEK_MS + 60_000));
    expect(summary.scored).toBe(1);
    expect(t7Requests()).toHaveLength(1);
    expect(t7Requests()[0].downstream_activity).toHaveLength(8);
    const activation = await prisma.activation.findUniqueOrThrow({ where: { id }, include: { decisions: true } });
    expect(activation.state).toBe("approved");
    expect(activation.decisions.map((d) => d.mode)).toEqual(["t0", "t7"]);
    expect(activation.decisions[1].trigger).toBe("hold_close");
  });

  it("sends a review band to a reviewer and refuses a reject band", async () => {
    const review = await heldActivation("review", 0.5);
    const reject = await heldActivation("reject", 0.9);
    fake.setHandler((request) =>
      request.activation.activation_id === review ? replyWith("review", 0.5)(request) : replyWith("reject", 0.9)(request),
    );
    await runDueScoringJobs(new Date(Date.now() + WEEK_MS + 60_000));
    expect((await prisma.activation.findUniqueOrThrow({ where: { id: review } })).state).toBe("in_review");
    expect((await prisma.reviewItem.findFirstOrThrow({ where: { activationId: review } })).openReason).toBe("band_review");
    expect((await prisma.activation.findUniqueOrThrow({ where: { id: reject } })).state).toBe("refused");
  });

  it("honours HOLD_WINDOW_SECONDS", async () => {
    process.env.HOLD_WINDOW_SECONDS = "60";
    const id = await heldActivation("auto_release", 0.05);
    const activation = await prisma.activation.findUniqueOrThrow({ where: { id } });
    expect(activation.holdClosesAt!.getTime() - activation.heldAt!.getTime()).toBe(60_000);
  });

  it("lets an admin force T7 on a held activation, applying the band", async () => {
    const admin = await createUser("admin");
    const id = await heldActivation("review", 0.5);
    expect(await forceT7(id, admin.id)).toBe("scored");
    const activation = await prisma.activation.findUniqueOrThrow({ where: { id }, include: { decisions: true } });
    expect(activation.state).toBe("in_review");
    expect(activation.decisions.at(-1)?.trigger).toBe("admin_forced");
    const forced = await prisma.auditEvent.findFirst({ where: { activationId: id, kind: "t7_forced", actorId: admin.id } });
    expect(forced).not.toBeNull();
  });

  it("stores a forced T7 on an activation in review as advice only", async () => {
    const admin = await createUser("admin");
    fake.setHandler(replyWith("reject", 0.9));
    const { activationId } = await submitReady();
    await addWeekOfActivity(activationId);
    fake.setHandler(replyWith("auto_release", 0.05));
    expect(await forceT7(activationId, admin.id)).toBe("advisory");
    const activation = await prisma.activation.findUniqueOrThrow({ where: { id: activationId }, include: { decisions: true } });
    expect(activation.state).toBe("in_review");
    expect(activation.decisions.map((d) => d.band)).toEqual(["reject", "auto_release"]);
  });

  it("refuses to force T7 on a final activation", async () => {
    const admin = await createUser("admin");
    const id = await heldActivation("auto_release", 0.05);
    await forceT7(id, admin.id);
    await expect(forceT7(id, admin.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe("durable schedule across process restarts (issue #7)", () => {
  const appDir = path.resolve(__dirname, "..");
  const tsxCli = path.join(appDir, "node_modules", "tsx", "dist", "cli.mjs");

  function runSchedulerProcess(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [tsxCli, "scripts/scheduler.ts", "--once"], {
        cwd: appDir,
        env: { ...process.env, SCORING_SERVICE_URL: fake.url },
      });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
    });
  }

  it("makes the T7 call exactly once even with restarts and two workers", async () => {
    process.env.HOLD_WINDOW_SECONDS = "4";
    const id = await heldActivation("auto_release", 0.05);

    const before = await runSchedulerProcess();
    expect(before).toContain('"scored":0');
    expect(t7Requests()).toHaveLength(0);

    const job = await prisma.scoringJob.findUniqueOrThrow({ where: { activationId_mode: { activationId: id, mode: "t7" } } });
    const wait = job.dueAt.getTime() - Date.now() + 500;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

    await Promise.all([runSchedulerProcess(), runSchedulerProcess()]);
    await runSchedulerProcess();

    expect(t7Requests()).toHaveLength(1);
    const activation = await prisma.activation.findUniqueOrThrow({ where: { id } });
    expect(activation.state).toBe("approved");
    expect(await prisma.scoringDecision.count({ where: { activationId: id, mode: "t7" } })).toBe(1);
  }, 120_000);
});

describe("first-week activity reporting", () => {
  it("only accepts reports from the client that owns the job", async () => {
    const { activationId } = await submitReady();
    const stranger = await createClient();
    await expect(
      reportActivity({
        clientId: stranger.id,
        activationId,
        actorId: stranger.userId,
        report: { days: [{ day: 0, customerActive: true, transactionCount: 1, topupAmountKsh: 20, usageMinutes: 3, supportContact: false, complaintOrRefund: false, simActive: true }] },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
