import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { decideAccess, requiredRole } from "@/lib/auth/policy";
import { registerUser, signupSchema } from "@/lib/auth/signup";
import { verifyPassword } from "@/lib/auth/password";
import { resetDatabase } from "./helpers/db";

beforeEach(resetDatabase);

describe("route policy (issue #2)", () => {
  it("maps every protected prefix to exactly one role", () => {
    expect(requiredRole("/admin/review/abc")).toBe("admin");
    expect(requiredRole("/api/admin/review")).toBe("admin");
    expect(requiredRole("/agent/activations")).toBe("agent");
    expect(requiredRole("/api/agent/activations")).toBe("agent");
    expect(requiredRole("/client/jobs/new")).toBe("client");
    expect(requiredRole("/api/client/jobs")).toBe("client");
    expect(requiredRole("/login")).toBeNull();
    expect(requiredRole("/administrator")).toBeNull();
  });

  it("lets each role reach only its own area", () => {
    const areas = ["/admin/review", "/agent/activations", "/client/jobs/new"] as const;
    const roles = ["admin", "agent", "client"] as const;
    for (const [index, path] of areas.entries()) {
      for (const role of roles) {
        expect(decideAccess(path, role)).toBe(role === roles[index] ? "allow" : "forbidden");
      }
      expect(decideAccess(path, null)).toBe("sign_in");
    }
  });

  it("keeps agents out of admin and client APIs and clients out of admin and agent APIs", () => {
    expect(decideAccess("/api/admin/review/x/approve", "agent")).toBe("forbidden");
    expect(decideAccess("/api/client/jobs", "agent")).toBe("forbidden");
    expect(decideAccess("/api/admin/review", "client")).toBe("forbidden");
    expect(decideAccess("/api/agent/activations", "client")).toBe("forbidden");
  });
});

describe("sign-up (issue #2)", () => {
  it("creates an agent with a profile and a hashed password", async () => {
    const input = signupSchema.parse({
      role: "agent",
      name: "Grace Wanjiku",
      email: "Grace@Example.com",
      password: "a-long-password",
      payoutMsisdn: "+254 712 345 678",
      homeAreaName: "Kariobangi",
      homeLat: "-1.25",
      homeLon: "36.88",
    });
    const user = await registerUser(input);
    const agent = await prisma.agent.findUniqueOrThrow({ where: { userId: user.id } });
    expect(user.email).toBe("grace@example.com");
    expect(user.role).toBe("agent");
    expect(agent.payoutMsisdn).toBe("0712345678");
    expect(await verifyPassword("a-long-password", user.passwordHash)).toBe(true);
  });

  it("creates a client business", async () => {
    const input = signupSchema.parse({
      role: "client", name: "Owner", email: "owner@biz.co.ke", password: "a-long-password", businessName: "Duka Telco",
    });
    const user = await registerUser(input);
    const client = await prisma.clientBusiness.findUniqueOrThrow({ where: { userId: user.id } });
    expect(client.name).toBe("Duka Telco");
  });

  it("refuses to create an admin through public sign-up", () => {
    const result = signupSchema.safeParse({
      role: "admin", name: "Mallory", email: "m@x.com", password: "a-long-password",
    });
    expect(result.success).toBe(false);
  });

  it("refuses a duplicate email with a conflict", async () => {
    const input = signupSchema.parse({
      role: "client", name: "Owner", email: "dup@biz.co.ke", password: "a-long-password", businessName: "Biz",
    });
    await registerUser(input);
    await expect(registerUser(input)).rejects.toMatchObject({ status: 409 });
  });
});
