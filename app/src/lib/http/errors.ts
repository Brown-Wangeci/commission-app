import { NextResponse } from "next/server";
import { ZodError } from "zod";

/**
 * One error shape for every API route:
 *   { "error": { "code": "...", "message": "...", "details": ... } }
 * Expected failures are ApiErrors with a 4xx status. Anything else is logged
 * and returned as a generic 500 with no stack trace or internal message.
 */
export type ErrorCode =
  | "bad_request"
  | "validation_failed"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "illegal_transition"
  | "payload_too_large"
  | "unsupported_media_type"
  | "internal_error";

export type ErrorBody = {
  error: { code: ErrorCode; message: string; details?: unknown };
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, details?: unknown): ApiError =>
  new ApiError(400, "bad_request", message, details);
export const unauthenticated = (): ApiError => new ApiError(401, "unauthenticated", "Sign in first.");
export const forbidden = (): ApiError =>
  new ApiError(403, "forbidden", "Your role cannot perform this action.");
export const notFound = (what: string): ApiError => new ApiError(404, "not_found", `${what} not found.`);
export const conflict = (message: string, details?: unknown): ApiError =>
  new ApiError(409, "conflict", message, details);

export function errorResponse(status: number, body: ErrorBody): NextResponse<ErrorBody> {
  return NextResponse.json(body, { status });
}

function fromZod(error: ZodError): ApiError {
  const details = error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  return new ApiError(422, "validation_failed", "Some fields are missing or invalid.", details);
}

/** Converts anything thrown in a route into the standard error response. */
export function toErrorResponse(error: unknown, route: string): NextResponse<ErrorBody> {
  const apiError = error instanceof ZodError ? fromZod(error) : error;
  if (apiError instanceof ApiError) {
    return errorResponse(apiError.status, {
      error: { code: apiError.code, message: apiError.message, details: apiError.details },
    });
  }
  console.error(`[${route}] unexpected error`, error);
  return errorResponse(500, {
    error: { code: "internal_error", message: "Something went wrong. The error has been logged." },
  });
}
