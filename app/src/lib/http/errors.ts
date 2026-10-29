import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { MoneyError } from "@/lib/money/cents";

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

const ILLEGAL_TRANSITION = /illegal activation transition/;
const FIXED_JOB_TERMS = /ledgerfield: (a published job's commission structure|a closed job cannot be reopened)/;

/**
 * Database errors that mean the request conflicts with the data, not that
 * the server failed. Anything else from the database stays a 500.
 */
function fromDatabase(error: unknown): ApiError | null {
  const message = error instanceof Error ? error.message : "";
  if (ILLEGAL_TRANSITION.test(message)) {
    return new ApiError(409, "illegal_transition", "That change is not allowed from the activation's current state.");
  }
  if (FIXED_JOB_TERMS.test(message)) {
    return new ApiError(409, "conflict", "A published job's commission, slots and escrow lock are fixed, and a closed job cannot reopen.");
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2025") return new ApiError(404, "not_found", "The record was not found.");
    if (error.code === "P2002") return new ApiError(409, "conflict", "That record already exists.");
    if (error.code === "P2003") return new ApiError(409, "conflict", "That refers to a record that does not exist.");
  }
  return null;
}

/** An amount the money rules refuse (not whole cents, too large) is invalid input. */
function fromMoney(error: unknown): ApiError | null {
  return error instanceof MoneyError ? new ApiError(422, "validation_failed", error.message) : null;
}

/** Converts anything thrown in a route into the standard error response. */
export function toErrorResponse(error: unknown, route: string): NextResponse<ErrorBody> {
  const apiError = error instanceof ZodError ? fromZod(error) : (fromMoney(error) ?? fromDatabase(error) ?? error);
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
