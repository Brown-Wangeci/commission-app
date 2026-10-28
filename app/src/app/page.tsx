import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import { homeFor } from "@/lib/auth/policy";

export default async function HomePage() {
  const user = await currentUser();
  redirect(user ? homeFor(user.role) : "/login");
}
