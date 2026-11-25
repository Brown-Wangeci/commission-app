import { clientFor } from "@/lib/auth/actors";
import { requireApiRole } from "@/lib/auth/session";
import { ok, readJson, withErrors } from "@/lib/http/route";
import { reviewSettingSchema, setClientReviewSetting } from "@/lib/review/requirement";

/** A client turns "reviewer required before any payment" on or off for its own business. */
export const POST = withErrors("POST /api/client/review-setting", async (request) => {
  const user = await requireApiRole("client");
  const client = await clientFor(user);
  const { reviewAllSubmissions } = await readJson(request, reviewSettingSchema);
  const { changed } = await setClientReviewSetting({ clientId: client.id, actorId: user.id, reviewAllSubmissions });
  return ok({ reviewAllSubmissions, changed });
});
