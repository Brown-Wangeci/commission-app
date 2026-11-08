import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRootEnv } from "../scripts/root-env";
import { b2cAmountProblem, centsToDarajaAmount, darajaAmountToCents, stkAmountProblem } from "@/lib/payments/amount";
import { originVerified, sourceAllowed, sourceIpOf } from "@/lib/payments/callback-origin";
import { callbackSignatureValid, callbackUrl, newReference } from "@/lib/payments/callback-url";
import { missingCredentials, mpesaCredentials } from "@/lib/payments/credentials";
import { classifyResponse, toDarajaMsisdn } from "@/lib/payments/daraja-client";
import { maskCallbackUrl, maskCheckoutId, maskPhone, redactPayload, redactText } from "@/lib/payments/redact";

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

describe("the Daraja money boundary (B2)", () => {
  it("converts cents to Daraja's amount exactly", () => {
    expect(centsToDarajaAmount(30_000)).toBe("300");
    expect(centsToDarajaAmount(100)).toBe("1");
    expect(centsToDarajaAmount(27_999)).toBe("279.99");
    expect(centsToDarajaAmount(25_000_000)).toBe("250000");
  });

  it("reads Daraja's amounts back exactly, whether number or text", () => {
    expect(darajaAmountToCents(1.0)).toBe(100);
    expect(darajaAmountToCents("300")).toBe(30_000);
    expect(darajaAmountToCents(10500.5)).toBe(1_050_050);
    expect(darajaAmountToCents(undefined)).toBeNull();
    expect(darajaAmountToCents("not money")).toBeNull();
  });

  it("refuses an amount it cannot send exactly, and never rounds", () => {
    expect(b2cAmountProblem(27_999)).toMatch(/includes cents.*not rounded/);
    expect(stkAmountProblem(10_050)).toMatch(/includes cents/);
    process.env.MPESA_WHOLE_SHILLINGS_ONLY = "false";
    expect(b2cAmountProblem(27_999)).toBeNull();
  });

  it("applies the documented limits, held in configuration", () => {
    expect(b2cAmountProblem(999)).toMatch(/below the M-Pesa minimum of KSh 10.00/);
    expect(b2cAmountProblem(1_000)).toBeNull();
    expect(b2cAmountProblem(25_000_000)).toBeNull();
    expect(b2cAmountProblem(25_000_100)).toMatch(/above the M-Pesa maximum/);
    expect(stkAmountProblem(100)).toBeNull();
    process.env.MPESA_B2C_MIN_CENTS = "5000";
    expect(b2cAmountProblem(1_000)).toMatch(/below/);
  });

  it("writes a Kenyan number the way Daraja wants it", () => {
    expect(toDarajaMsisdn("0712345678")).toBe("254712345678");
    expect(toDarajaMsisdn("0112345678")).toBe("254112345678");
    expect(() => toDarajaMsisdn("12345")).toThrow(/not a Kenyan mobile number/);
  });
});

describe("classifying Daraja's answers: what may be sent again", () => {
  it("accepts only ResponseCode 0 on a success status", () => {
    expect(classifyResponse(200, { ResponseCode: "0", ConversationID: "AG_1" })).toMatchObject({ kind: "accepted" });
    expect(classifyResponse(200, { ResponseCode: 0 })).toMatchObject({ kind: "accepted" });
    expect(classifyResponse(200, { ResponseCode: "1", ResponseDescription: "No" })).toMatchObject({ kind: "refused", retryable: false });
  });

  it("recognises a repeated OriginatorConversationID as already held, not as a failure", () => {
    const outcome = classifyResponse(500, { requestId: "x", errorCode: "500.002.1001", errorMessage: "Duplicate OriginatorConversationID." });
    expect(outcome).toMatchObject({ kind: "refused", duplicate: true, retryable: false });
  });

  it("retries the documented busy and server errors, and not bad requests", () => {
    expect(classifyResponse(500, { errorCode: "500.003.02", errorMessage: "System is busy. Please try again in few minutes." })).toMatchObject({ retryable: true });
    expect(classifyResponse(500, { errorCode: "500.003.1001", errorMessage: "Internal Server Error" })).toMatchObject({ retryable: true });
    expect(classifyResponse(404, { errorCode: "404.001.03", errorMessage: "Invalid Access Token" })).toMatchObject({ retryable: true });
    expect(classifyResponse(400, { errorCode: "400.002.02", errorMessage: "Bad Request - Invalid Amount" })).toMatchObject({ retryable: false });
    expect(classifyResponse(500, { errorCode: "500.001.1001", errorMessage: "Merchant does not exist" })).toMatchObject({ retryable: false });
  });

  it("treats 429 and 503 as not delivered, and anything unrecognised as unknown", () => {
    expect(classifyResponse(503, null)).toMatchObject({ kind: "not_delivered" });
    expect(classifyResponse(429, "busy")).toMatchObject({ kind: "not_delivered" });
    expect(classifyResponse(502, null)).toMatchObject({ kind: "unknown" });
    expect(classifyResponse(504, "<html>")).toMatchObject({ kind: "unknown" });
    expect(classifyResponse(200, null)).toMatchObject({ kind: "unknown" });
    expect(classifyResponse(200, { unexpected: true })).toMatchObject({ kind: "unknown" });
  });
});

describe("callback URLs (IR-02)", () => {
  const reference = "0123456789abcdef0123456789abcdef";

  it("builds every URL from MPESA_CALLBACK_BASE_URL, so no host is fixed", () => {
    process.env.MPESA_CALLBACK_BASE_URL = "https://first-tunnel.trycloudflare.com";
    const first = callbackUrl("stk", reference);
    process.env.MPESA_CALLBACK_BASE_URL = "https://second-tunnel.trycloudflare.com/";
    const second = callbackUrl("stk", reference);
    expect(first.startsWith("https://first-tunnel.trycloudflare.com/api/payments/callback/stk/")).toBe(true);
    expect(second.startsWith("https://second-tunnel.trycloudflare.com/api/payments/callback/stk/")).toBe(true);
    expect(new URL(first).pathname).toBe(new URL(second).pathname);
  });

  it("refuses a callback base that is not HTTPS, because Daraja requires it", () => {
    process.env.MPESA_CALLBACK_BASE_URL = "http://localhost:3000";
    expect(mpesaCredentials()).toBeNull();
    expect(missingCredentials()).toEqual(["MPESA_CALLBACK_BASE_URL"]);
  });

  it("uses none of the words Daraja forbids in a URL", () => {
    for (let i = 0; i < 200; i += 1) {
      const path = new URL(callbackUrl("status-timeout", newReference())).pathname;
      expect(path).not.toMatch(/m-?pesa|safaricom|exec|exe|cmd|sql|query/i);
    }
  });

  it("accepts only the exact signature for that kind and reference", () => {
    const signature = callbackUrl("stk", reference).split("/").at(-1) as string;
    expect(callbackSignatureValid("stk", reference, signature)).toBe(true);
    expect(callbackSignatureValid("b2c-result", reference, signature)).toBe(false);
    expect(callbackSignatureValid("stk", "f".repeat(32), signature)).toBe(false);
    expect(callbackSignatureValid("stk", reference, signature.replace(/.$/, "0") === signature ? signature.replace(/.$/, "1") : signature.replace(/.$/, "0"))).toBe(false);
    expect(callbackSignatureValid("stk", reference, "")).toBe(false);
  });

  it("invalidates every signature if the consumer secret changes", () => {
    const signature = callbackUrl("stk", reference).split("/").at(-1) as string;
    process.env.MPESA_CONSUMER_SECRET = "a-different-secret";
    expect(callbackSignatureValid("stk", reference, signature)).toBe(false);
    delete process.env.MPESA_CONSUMER_SECRET;
    expect(callbackSignatureValid("stk", reference, signature)).toBe(false);
  });

  it("applies the optional source list on top of the signature, never instead of it", () => {
    const signature = callbackUrl("stk", reference).split("/").at(-1) as string;
    const check = { kind: "stk" as const, reference, signature, sourceIp: "196.201.214.200" };
    expect(originVerified(check)).toBe(true);
    process.env.MPESA_CALLBACK_ALLOWED_IPS = "10.0.0.0/8";
    expect(originVerified(check)).toBe(false);
    process.env.MPESA_CALLBACK_ALLOWED_IPS = "196.201.214.0/24";
    expect(originVerified(check)).toBe(true);
    expect(originVerified({ ...check, signature: "0".repeat(64) })).toBe(false);
  });

  it("matches addresses and ranges", () => {
    expect(sourceAllowed("1.2.3.4", "")).toBe(true);
    expect(sourceAllowed("1.2.3.4", "1.2.3.4, 5.6.7.8")).toBe(true);
    expect(sourceAllowed("1.2.3.5", "1.2.3.4")).toBe(false);
    expect(sourceAllowed("1.2.3.200", "1.2.3.0/24")).toBe(true);
    expect(sourceAllowed("1.2.4.1", "1.2.3.0/24")).toBe(false);
    expect(sourceAllowed(null, "1.2.3.4")).toBe(false);
    expect(sourceAllowed("not-an-ip", "1.2.3.0/24")).toBe(false);
  });

  it("reads the address the nearest proxy recorded, not one a caller put first", () => {
    expect(sourceIpOf(new Headers({ "x-forwarded-for": "6.6.6.6, 196.201.214.200" }))).toBe("196.201.214.200");
    expect(sourceIpOf(new Headers())).toBeNull();
  });
});

describe("credentials stay out of everything (E1)", () => {
  it("masks numbers and strips signatures", () => {
    expect(maskPhone("254712345678")).toBe("2547******678");
    expect(maskPhone("0712345678")).toBe("07******678");
    expect(maskPhone("600992")).toBe("600992");
    expect(maskCallbackUrl("https://x.test/api/payments/callback/stk/abc123/deadbeef")).toBe("https://x.test/api/payments/callback/stk/abc123/[redacted]");
  });

  it("removes every credential from a request payload", () => {
    const safe = JSON.stringify(
      redactPayload({
        InitiatorName: "test-initiator",
        SecurityCredential: "test-security-credential",
        Password: "base64-password",
        PartyA: "600000",
        PartyB: "254712345678",
        PhoneNumber: 254712345678,
        Amount: "300",
        ResultURL: "https://x.test/api/payments/callback/b2c-result/abc/feedface",
      }),
    );
    for (const secret of ["test-initiator", "test-security-credential", "base64-password", "254712345678", "feedface"]) expect(safe).not.toContain(secret);
    expect(safe).toContain("600000");
    expect(safe).toContain('"Amount":"300"');
  });

  it("hides the payer's number inside a checkout id, as the real sandbox sends it", () => {
    const id = "ws_CO_071120261159070712345678";
    expect(maskCheckoutId(id)).toBe("ws_CO_07112026115907*******678");
    const safe = JSON.stringify(redactPayload({ Body: { stkCallback: { CheckoutRequestID: id, MerchantRequestID: "135b-4679" } } }));
    expect(safe).not.toContain("12345678");
    expect(safe).toContain("135b-4679");
  });

  it("removes names and numbers held in Daraja's key and value lists", () => {
    const safe = JSON.stringify(
      redactPayload({
        Items: [
          { Key: "ReceiverPartyPublicName", Value: "254705912645 - NICHOLAS JOHN SONGOK" },
          { Name: "PhoneNumber", Value: 254708374149 },
          { Key: "TransactionReceipt", Value: "SG632NMUAB" },
        ],
      }),
    );
    expect(safe).not.toContain("SONGOK");
    expect(safe).not.toContain("254705912645");
    expect(safe).not.toContain("254708374149");
    expect(safe).toContain("SG632NMUAB");
  });

  it("scrubs known secret values from text even while configuration is incomplete", () => {
    delete process.env.MPESA_CALLBACK_BASE_URL;
    expect(mpesaCredentials()).toBeNull();
    const text = redactText("failed with test-consumer-secret and test-stk-passkey for 0712345678, Bearer abc.def and Basic Zm9v");
    expect(text).toBe("failed with [redacted] and [redacted] for 07******678, Bearer [redacted] and Basic [redacted]");
  });

  it("names a missing variable without showing any value", () => {
    delete process.env.MPESA_STK_PASSKEY;
    expect(missingCredentials()).toEqual(["MPESA_STK_PASSKEY"]);
    expect(JSON.stringify(missingCredentials())).not.toContain("test-");
  });
});

describe("loading the root .env", () => {
  function fixture(contents: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mpesa-env-"));
    fs.mkdirSync(path.join(root, "app"));
    fs.writeFileSync(path.join(root, ".env"), contents);
    return path.join(root, "app");
  }

  it("takes only MPESA_ and POLYGON_ names and never replaces a value already set", () => {
    process.env.MPESA_ENV = "already-set";
    delete process.env.MPESA_STK_SHORTCODE;
    delete process.env.POLYGON_CHAIN_ID;
    delete process.env.ROOT_ONLY_SETTING;
    loadRootEnv(fixture("MPESA_ENV=sandbox\r\nMPESA_STK_SHORTCODE=174379\r\nPOLYGON_CHAIN_ID=80002\r\nROOT_ONLY_SETTING=leak\r\n"));
    expect(process.env.MPESA_ENV).toBe("already-set");
    expect(process.env.MPESA_STK_SHORTCODE).toBe("174379");
    expect(process.env.POLYGON_CHAIN_ID).toBe("80002");
    expect(process.env.ROOT_ONLY_SETTING).toBeUndefined();
  });

  it("lists the Polygon settings in .env.example as commented-out placeholders only", () => {
    const example = fs.readFileSync(path.resolve(__dirname, "..", ".env.example"), "utf8");
    for (const name of ["POLYGON_RPC_URL", "POLYGON_CHAIN_ID", "POLYGON_PRIVATE_KEY", "POLYGON_ANCHOR_CONTRACT_ADDRESS"]) {
      expect(new RegExp(`^# ${name}="replace-with-your-value"$`, "m").test(example), name).toBe(true);
      expect(new RegExp(`^${name}=`, "m").test(example), name).toBe(false);
    }
  });

  it("does nothing when there is no root .env", () => {
    expect(() => loadRootEnv(path.join(os.tmpdir(), "no-such-root", "app"))).not.toThrow();
  });
});

describe("the repository holds no secrets (E2, E3)", () => {
  const appDir = path.resolve(__dirname, "..");
  const example = fs.readFileSync(path.join(appDir, ".env.example"), "utf8");

  function assignment(name: string): string | null {
    return new RegExp(`^# ${name}=(.*)$`, "m").exec(example)?.[1].trim() ?? null;
  }

  it("lists every credential in .env.example as a commented-out placeholder", () => {
    for (const name of ["MPESA_CONSUMER_KEY", "MPESA_CONSUMER_SECRET", "MPESA_STK_SHORTCODE", "MPESA_STK_PASSKEY", "MPESA_B2C_SHORTCODE", "MPESA_B2C_INITIATOR_NAME", "MPESA_B2C_SECURITY_CREDENTIAL"]) {
      expect(assignment(name), name).toBe('"replace-with-your-value"');
    }
    expect(assignment("MPESA_CALLBACK_BASE_URL")).toBe('"https://your-tunnel-host.example"');
  });

  it("ignores every .env variant and keeps the example tracked", () => {
    const variants = [".env", ".env.local", ".env.production", ".env.sandbox", "app/.env", "app/.env.local", "app/.env.production.local", "app/.env.daraja"];
    const repo = path.resolve(appDir, "..");
    for (const file of variants) {
      expect(() => execFileSync("git", ["check-ignore", "-q", file], { cwd: repo }), file).not.toThrow();
    }
    expect(() => execFileSync("git", ["check-ignore", "-q", "app/.env.example"], { cwd: repo })).toThrow();
  });
});
