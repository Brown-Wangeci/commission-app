import { NextResponse, type NextRequest } from "next/server";
import type { ZodType, ZodTypeDef } from "zod";
import { badRequest, toErrorResponse } from "./errors";

type Context<P> = { params: Promise<P> };
type Handler<P> = (request: NextRequest, context: Context<P>) => Promise<Response>;

/** Wraps a route handler so every thrown error becomes the standard error body. */
export function withErrors<P = Record<string, string>>(name: string, handler: Handler<P>): Handler<P> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      return toErrorResponse(error, name);
    }
  };
}

/** Parses a JSON body against a schema. Malformed JSON is a 400, invalid fields a 422. */
export async function readJson<T>(request: Request, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw badRequest("The request body must be valid JSON.");
  }
  return schema.parse(body);
}

export function ok<T>(body: T, status = 200): NextResponse<T> {
  return NextResponse.json(body, { status });
}
