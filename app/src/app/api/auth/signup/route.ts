import { registerUser, signupSchema } from "@/lib/auth/signup";
import { ok, readJson, withErrors } from "@/lib/http/route";

export const POST = withErrors("POST /api/auth/signup", async (request) => {
  const input = await readJson(request, signupSchema);
  const user = await registerUser(input);
  return ok({ id: user.id, email: user.email, role: user.role }, 201);
});
