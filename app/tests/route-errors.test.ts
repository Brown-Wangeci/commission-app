import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, toErrorResponse } from "@/lib/http/errors";
import { readJson, withErrors } from "@/lib/http/route";

afterEach(() => vi.restoreAllMocks());

async function bodyOf(response: Response) {
  return { status: response.status, body: (await response.json()) as { error: { code: string; message: string; details?: unknown } } };
}

describe("one error shape for every route (issue #18)", () => {
  it("turns invalid fields into a 422 with per-field details", async () => {
    const parsed = z.object({ reason: z.string().min(5) }).safeParse({ reason: "no" });
    const { status, body } = await bodyOf(toErrorResponse(parsed.error, "test"));
    expect(status).toBe(422);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details).toEqual([{ path: "reason", message: expect.any(String) }]);
  });

  it("passes expected errors through with their own status", async () => {
    const { status, body } = await bodyOf(toErrorResponse(new ApiError(409, "conflict", "Already decided."), "test"));
    expect(status).toBe(409);
    expect(body).toEqual({ error: { code: "conflict", message: "Already decided." } });
  });

  it("maps a database-rejected transition to 409, not 500", async () => {
    const error = new Error("ledgerfield: illegal activation transition approved -> refused");
    expect((await bodyOf(toErrorResponse(error, "test"))).status).toBe(409);
  });

  it("maps missing and duplicate records to 404 and 409", async () => {
    const missing = new Prisma.PrismaClientKnownRequestError("No record", { code: "P2025", clientVersion: "6.19.3" });
    const duplicate = new Prisma.PrismaClientKnownRequestError("Unique", { code: "P2002", clientVersion: "6.19.3" });
    expect((await bodyOf(toErrorResponse(missing, "test"))).status).toBe(404);
    expect((await bodyOf(toErrorResponse(duplicate, "test"))).status).toBe(409);
  });

  it("logs an unexpected failure and returns a generic 500 with no internal detail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await bodyOf(toErrorResponse(new TypeError("cannot read secretField of undefined"), "POST /x"));
    expect(status).toBe(500);
    expect(body.error.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toMatch(/secretField|TypeError|at /);
    expect(log).toHaveBeenCalledOnce();
  });

  it("wraps handlers so malformed JSON is a 400", async () => {
    const handler = withErrors("POST /test", async (request) => {
      await readJson(request, z.object({ a: z.number() }));
      return new Response("ok");
    });
    const request = new NextRequest("http://localhost/test", { method: "POST", body: "{not json" });
    const { status, body } = await bodyOf(await handler(request, { params: Promise.resolve({}) }));
    expect(status).toBe(400);
    expect(body.error.code).toBe("bad_request");
  });
});
