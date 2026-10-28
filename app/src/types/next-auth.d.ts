import type { DefaultSession } from "next-auth";
import type { RoleName } from "@/lib/auth/policy";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & { id: string; role: RoleName };
  }
  interface User {
    role: RoleName;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: RoleName;
    userId?: string;
  }
}
