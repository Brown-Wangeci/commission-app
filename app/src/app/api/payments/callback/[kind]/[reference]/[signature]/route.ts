import { ApiError, badRequest } from "@/lib/http/errors";
import { ok, withErrors } from "@/lib/http/route";
import { sourceIpOf, originVerified } from "@/lib/payments/callback-origin";
import { isCallbackKind } from "@/lib/payments/callback-url";
import { handleCallback } from "@/lib/payments/callbacks";
import { capture } from "@/lib/payments/capture";

type Params = { kind: string; reference: string; signature: string };

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Where Daraja delivers payment results (IR-02). Outside the signed-in area,
 * so it verifies origin itself, first, before reading the body. A refusal says
 * nothing about why and logs no part of the URL.
 *
 * Every verified callback is acknowledged, including duplicates and unknown
 * references: they have been recorded, and asking Daraja to repeat them would
 * achieve nothing. A 500 is returned only if recording failed, so that nothing
 * is lost if it is delivered again.
 */
export const POST = withErrors<Params>("POST /api/payments/callback", async (request, context) => {
  const { kind, reference, signature } = await context.params;
  const verified = isCallbackKind(kind) && originVerified({ kind, reference, signature, sourceIp: sourceIpOf(request.headers) });
  if (!verified) {
    console.warn("[payments] refused a callback that failed origin verification");
    throw new ApiError(401, "unauthenticated", "Not accepted.");
  }
  const body = await request.text();
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large", "Not accepted.");
  const payload = parseJson(body);
  capture({ direction: "callback", label: kind, payload });
  await handleCallback({ kind, reference, payload });
  return ok({ ResultCode: 0, ResultDesc: "Accepted" });
});

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw badRequest("Not accepted.");
  }
}
