import { Prisma, type User } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { conflict } from "@/lib/http/errors";
import {
  emailSchema,
  kenyanMsisdnSchema,
  latitudeSchema,
  longitudeSchema,
  nameSchema,
  passwordSchema,
} from "@/lib/validation";
import { hashPassword } from "./password";

const common = {
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
};

/**
 * Public sign-up creates agent and client accounts only. Admin accounts are
 * created by the seed script or by an existing administrator's database
 * tooling, never through a public form.
 */
export const signupSchema = z.discriminatedUnion("role", [
  z.object({
    ...common,
    role: z.literal("agent"),
    payoutMsisdn: kenyanMsisdnSchema,
    homeAreaName: nameSchema,
    homeLat: latitudeSchema,
    homeLon: longitudeSchema,
  }),
  z.object({
    ...common,
    role: z.literal("client"),
    businessName: nameSchema,
  }),
]);

export type SignupInput = z.infer<typeof signupSchema>;

function profileFor(input: SignupInput): Pick<Prisma.UserCreateInput, "agent" | "client"> {
  if (input.role === "agent") {
    return {
      agent: {
        create: {
          payoutMsisdn: input.payoutMsisdn,
          registeredAt: new Date(),
          homeLat: input.homeLat,
          homeLon: input.homeLon,
          homeAreaName: input.homeAreaName,
        },
      },
    };
  }
  return { client: { create: { name: input.businessName } } };
}

export async function registerUser(input: SignupInput): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash,
        role: input.role,
        ...profileFor(input),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw conflict("An account with this email already exists.");
    }
    throw error;
  }
}
