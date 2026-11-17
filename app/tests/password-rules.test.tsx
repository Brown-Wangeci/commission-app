import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PasswordInput, passwordInputType } from "@/components/PasswordInput";
import { PasswordRules } from "@/components/PasswordRules";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import {
  checkPassword,
  classesIn,
  confirmationProblem,
  MIN_PASSWORD_LENGTH,
  passwordProblems,
} from "@/lib/auth/password-rules";
import { signupSchema } from "@/lib/auth/signup";
import { passwordSchema } from "@/lib/validation";

/** The sign-up password rule: at least 8 characters and three of four character classes. */

const GOOD = "Fake-Value-123"; // an obviously fake value that satisfies the rule
const LENGTH_PROBLEM = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
const CLASS_PROBLEM = "Use at least 3 of: lower case, upper case, a digit and a symbol.";

describe("length", () => {
  it("refuses a password shorter than the minimum, whatever it contains", () => {
    const short = "Ab1!Ab1"; // 7 characters, all four classes
    expect(short.length).toBeLessThan(MIN_PASSWORD_LENGTH);
    expect(passwordProblems(short)).toEqual([LENGTH_PROBLEM]);
  });

  it("accepts a password exactly at the minimum", () => {
    const exactlyEight = GOOD.slice(0, MIN_PASSWORD_LENGTH); // "Fake-Val": lower, upper and a symbol
    expect(exactlyEight).toHaveLength(MIN_PASSWORD_LENGTH);
    expect(passwordProblems(exactlyEight)).toEqual([]);
  });

  it("reports every unmet rule together", () => {
    expect(passwordProblems("abc")).toEqual([LENGTH_PROBLEM, CLASS_PROBLEM]);
  });

  it("still refuses an overlong password", () => {
    expect(passwordSchema.safeParse(`${GOOD}${"x".repeat(200)}`).success).toBe(false);
  });
});

describe("character classes", () => {
  it("counts lower, upper, digit and symbol", () => {
    expect(classesIn("abc")).toEqual(["lower"]);
    expect(classesIn("aB")).toEqual(["lower", "upper"]);
    expect(classesIn("aB3")).toEqual(["lower", "upper", "digit"]);
    expect(classesIn("aB3-")).toEqual(["lower", "upper", "digit", "symbol"]);
    expect(classesIn("a b")).toEqual(["lower", "symbol"]);
  });

  it("refuses two classes, however long", () => {
    expect(passwordProblems("lowercaseonlywordsagain")).toEqual([CLASS_PROBLEM]);
    expect(passwordProblems("lower-case-and-symbols-only")).toEqual([CLASS_PROBLEM]);
    expect(passwordProblems("UPPER1234567890")).toEqual([CLASS_PROBLEM]);
  });

  it("accepts any three of the four", () => {
    expect(passwordProblems("lowerUPPERdigits123")).toEqual([]); // lower, upper, digit
    expect(passwordProblems("lowerupper-with-1234")).toEqual([]); // lower, digit, symbol
    expect(passwordProblems("UPPERCASE-WITH-SYMBOL-9")).toEqual([]); // upper, digit, symbol
    expect(passwordProblems("Lower-Upper-Symbol-Only")).toEqual([]); // lower, upper, symbol
  });
});

describe("the live rule list", () => {
  it("marks each rule met or not as the password changes", () => {
    expect(checkPassword("Fake-1").map((c) => [c.id, c.ok])).toEqual([["length", false], ["classes", true]]);
    expect(checkPassword("lowercaseonly").map((c) => [c.id, c.ok])).toEqual([["length", true], ["classes", false]]);
    expect(checkPassword(GOOD).every((c) => c.ok)).toBe(true);
  });

  it("renders every rule as not yet before anything is typed, and as met once satisfied", () => {
    const empty = renderToStaticMarkup(<PasswordRules id="r" password="" />);
    expect(empty.match(/Not yet/g)).toHaveLength(2);
    expect(empty).not.toContain(">Met<");
    const good = renderToStaticMarkup(<PasswordRules id="r" password={GOOD} />);
    expect(good.match(/class="met"/g)).toHaveLength(2);
    expect(good).not.toContain("Not yet");
    expect(good).toContain('aria-live="polite"');
  });
});

describe("the server applies the same rule", () => {
  const base = { role: "client" as const, name: "Owner", email: "owner@biz.co.ke", businessName: "Biz" };

  it("rejects a weak password at sign-up with the rule's own message", () => {
    const result = signupSchema.safeParse({ ...base, password: "a-long-password" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toBe(CLASS_PROBLEM);
  });

  it("accepts a password that meets the rule", () => {
    expect(signupSchema.safeParse({ ...base, password: GOOD }).success).toBe(true);
  });
});

describe("confirming the password", () => {
  it("reports a mismatch, and says nothing before the confirm field is used", () => {
    expect(confirmationProblem(GOOD, "")).toBeNull();
    expect(confirmationProblem(GOOD, GOOD)).toBeNull();
    expect(confirmationProblem(GOOD, `${GOOD}x`)).toBe("The two passwords do not match.");
    expect(confirmationProblem(GOOD, GOOD.toLowerCase())).toBe("The two passwords do not match.");
  });
});

describe("the show/hide control", () => {
  it("switches the input between hidden and plain text", () => {
    expect(passwordInputType(false)).toBe("password");
    expect(passwordInputType(true)).toBe("text");
  });

  it("starts hidden, with a button that names its state and never submits the form", () => {
    const html = renderToStaticMarkup(<PasswordInput id="p" name="password" autoComplete="current-password" />);
    expect(html).toContain('type="password"');
    expect(html).toMatch(/<button type="button"[^>]*aria-pressed="false"[^>]*aria-label="Show password"/);
  });

  it("is on every password field the app renders", () => {
    for (const file of ["src/app/login/LoginForm.tsx", "src/app/signup/SignupForm.tsx"]) {
      const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      expect(source, file).not.toMatch(/type="password"/);
      expect(source, file).toMatch(/<PasswordInput/);
    }
    const signup = fs.readFileSync(path.join(__dirname, "..", "src/app/signup/SignupForm.tsx"), "utf8");
    expect(signup.match(/<PasswordInput/g)).toHaveLength(2);
  });
});

describe("accounts made before the rule keep working", () => {
  const SEEDED = "ledgerfield-demo";

  it("verifies the seeded demonstration password, which the sign-up rule would refuse", async () => {
    expect(passwordSchema.safeParse(SEEDED).success).toBe(false);
    expect(await verifyPassword(SEEDED, await hashPassword(SEEDED))).toBe(true);
  });

  it("keeps the rule out of the sign-in path", () => {
    for (const file of ["src/lib/auth/options.ts", "src/lib/auth/password.ts"]) {
      const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      expect(source, file).not.toMatch(/password-rules|passwordSchema|passwordProblems/);
    }
  });
});
