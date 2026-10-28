import { errorResponse } from "@/lib/http/errors";

/** Any /api path with no route answers in the standard error shape, not an HTML page. */
function notFound(): Response {
  return errorResponse(404, { error: { code: "not_found", message: "No API route matches this path." } });
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
