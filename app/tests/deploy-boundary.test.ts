import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prismaEnv } from "../scripts/prisma-env";

/**
 * What the hosted deployment relies on, checked statically: the Vercel
 * build and runtime need no local PostgreSQL, migrations use the direct
 * (unpooled) connection, and every route that does queued work inside a
 * request is bounded by the function limit and the cron secret.
 */
const appDir = path.resolve(__dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(appDir, relative), "utf8");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe("embedded-postgres is for development and tests only", () => {
  it("is a devDependency, never a dependency", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.dependencies["embedded-postgres"]).toBeUndefined();
    expect(pkg.devDependencies["embedded-postgres"]).toBeDefined();
  });

  it("nothing the app builds or serves imports it", () => {
    const files = [...sourceFiles(path.join(appDir, "src")), path.join(appDir, "next.config.ts")];
    const importers = files.filter((file) => /from\s+["']embedded-postgres["']|require\(["']embedded-postgres["']\)/.test(fs.readFileSync(file, "utf8")));
    expect(importers).toEqual([]);
  });
});

describe("Prisma uses the unpooled URL for migrations", () => {
  it("the schema names DATABASE_URL for the app and DATABASE_URL_UNPOOLED as directUrl", () => {
    const schema = read("prisma/schema.prisma");
    expect(schema).toMatch(/url\s*=\s*env\("DATABASE_URL"\)/);
    expect(schema).toMatch(/directUrl\s*=\s*env\("DATABASE_URL_UNPOOLED"\)/);
  });

  it("locally, the unpooled URL defaults to DATABASE_URL", () => {
    expect(prismaEnv({ DATABASE_URL: "postgresql://local/db" }).DATABASE_URL_UNPOOLED).toBe("postgresql://local/db");
  });

  it("hosted, a given unpooled URL is kept", () => {
    const env = prismaEnv({ DATABASE_URL: "postgresql://pooled/db", DATABASE_URL_UNPOOLED: "postgresql://direct/db" });
    expect(env).toMatchObject({ DATABASE_URL: "postgresql://pooled/db", DATABASE_URL_UNPOOLED: "postgresql://direct/db" });
  });

  it("refuses to run without DATABASE_URL", () => {
    expect(() => prismaEnv({})).toThrow(/DATABASE_URL is not set/);
  });

  it("every npm script that migrates goes through scripts/prisma-env.ts", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    const migrating = Object.entries(scripts).filter(([, command]) => /prisma[^&]*migrate/.test(command));
    expect(migrating.length).toBeGreaterThan(0);
    for (const [name, command] of migrating) expect(command, name).toMatch(/tsx scripts\/prisma-env\.ts migrate/);
  });
});

describe("queued work inside a request fits the function limit", () => {
  // Read from the directory, so a cron route added later is held to the same contract without being listed here.
  const CRON_ROUTES = fs.readdirSync(path.join(appDir, "src/app/api/cron")).map((name) => `src/app/api/cron/${name}/route.ts`);
  const ALL = [...CRON_ROUTES, "src/app/api/admin/scoring/run-due/route.ts"];

  it.each(ALL)("%s declares maxDuration within Vercel Hobby's 300 s and runs to a deadline", (file) => {
    const text = read(file);
    const declared = Number(/export const maxDuration = (\d+);/.exec(text)?.[1]);
    expect(declared).toBeGreaterThan(0);
    expect(declared).toBeLessThanOrEqual(300);
    expect(text).toContain("requestDeadline()");
  });

  it.each(CRON_ROUTES)("%s is a POST behind CRON_SECRET", (file) => {
    const text = read(file);
    expect(text).toMatch(/export const POST = /);
    expect(text).toContain("requireCronSecret(request)");
  });

  it("the submission route, which scores at T0 in the request, declares maxDuration too", () => {
    expect(read("src/app/api/agent/activations/route.ts")).toMatch(/export const maxDuration = 300;/);
  });

  it("functions run in fra1, next to the Neon database in eu-central-1", () => {
    expect(JSON.parse(read("vercel.json"))).toMatchObject({ regions: ["fra1"] });
  });
});

describe("PRISMA_TRANSACTION_TIMEOUT_MS (remote seeding only)", () => {
  it("leaves Prisma's defaults alone when unset, empty or invalid", async () => {
    const { clientOptions } = await import("@/lib/db");
    for (const value of [undefined, "", "abc", "0", "-5", "1.5"]) expect(clientOptions({ PRISMA_TRANSACTION_TIMEOUT_MS: value }), String(value)).toEqual({});
  });

  it("sets the interactive transaction timeout when given", async () => {
    const { clientOptions } = await import("@/lib/db");
    expect(clientOptions({ PRISMA_TRANSACTION_TIMEOUT_MS: "30000" })).toEqual({ transactionOptions: { timeout: 30000, maxWait: 30000 } });
  });
});

describe("scripts/seed-hosted.ts", () => {
  const complete = { VERCEL: "1", DATABASE_URL: "postgresql://u:p@ep-x-pooler.example/db?sslmode=require", DATABASE_URL_UNPOOLED: "postgresql://u:p@ep-x.example/db?sslmode=require", BLOB_READ_WRITE_TOKEN: "t", SCORING_SERVICE_URL: "https://s.example", MSISDN_HASH_SALT: "0123456789abcdef" };

  it("seeds over the direct URL with one connection and a 30 s transaction timeout", async () => {
    const { hostedSeedEnv } = await import("../scripts/seed-hosted");
    expect(hostedSeedEnv(complete)).toMatchObject({ DATABASE_URL: "postgresql://u:p@ep-x.example/db?sslmode=require&connection_limit=1", PRISMA_TRANSACTION_TIMEOUT_MS: "30000" });
  });

  it("refuses a pull without the Blob token, a non-Vercel file, or a pooled direct URL", async () => {
    const { hostedSeedEnv } = await import("../scripts/seed-hosted");
    expect(() => hostedSeedEnv({ ...complete, BLOB_READ_WRITE_TOKEN: undefined })).toThrow(/BLOB_READ_WRITE_TOKEN/);
    expect(() => hostedSeedEnv({ ...complete, VERCEL: undefined })).toThrow(/not a Vercel pull/);
    expect(() => hostedSeedEnv({ ...complete, DATABASE_URL_UNPOOLED: complete.DATABASE_URL })).toThrow(/pooled host/);
  });
});
