import { z } from "zod";
import { clientFor } from "@/lib/auth/actors";
import { requireApiRole } from "@/lib/auth/session";
import { fundEscrow } from "@/lib/escrow/client";
import { ok, readJson, withErrors } from "@/lib/http/route";
import { centsSchema } from "@/lib/validation";

const bodySchema = z.object({ amountCents: centsSchema("The deposit", 1) });

/** The client adds money to its escrow balance. */
export const POST = withErrors("POST /api/client/escrow/fund", async (request) => {
  const user = await requireApiRole("client");
  const client = await clientFor(user);
  const { amountCents } = await readJson(request, bodySchema);
  const deposit = await fundEscrow({ clientId: client.id, amountCents, actorId: user.id });
  return ok({ depositId: deposit.id, amountCents: deposit.amountCents }, 201);
});
