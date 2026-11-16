/**
 * Where does Daraja deliver STK callbacks? A diagnostic, not part of the app.
 * It writes nothing to the database and changes no payment code.
 *
 *   listen <port> <out.jsonl>
 *       A local HTTP listener (reach it through a tunnel). Records each request:
 *       time, method, path shape, a few headers, and the body with any phone
 *       number replaced. Answers 200 as Daraja expects.
 *   push <label> <origin> <valid|bogus> <out.json>
 *       One STK Push of KSh 1 to the sandbox payer, whose callback URL is
 *       <origin>/api/payments/callback/stk/<reference>/<signature>. "valid" signs
 *       it as the app would; "bogus" uses a signature the app refuses (401, no
 *       database write). Saves Daraja's answer. The payer cancels on the phone.
 *   query <checkoutRequestId>
 *       Asks Daraja's STK Query for that request and prints the result.
 *
 * Usage, from app/ (reads the pulled hosted settings; prints no secret):
 *   node --env-file=.env.hosted node_modules/tsx/dist/cli.mjs scripts/mpesa-callback-experiment.ts <command> ...
 */
import fs from "node:fs";
import http from "node:http";
import { config } from "../src/lib/config";
import { callbackUrl, newReference } from "../src/lib/payments/callback-url";
import { mpesaCredentials, type MpesaCredentials } from "../src/lib/payments/credentials";
import { toDarajaMsisdn } from "../src/lib/payments/daraja-client";
import { toServiceTime } from "../src/lib/scoring/time";

const AMOUNT_KSH = "1";
const KEPT_HEADERS = ["content-type", "user-agent", "x-forwarded-for", "cf-connecting-ip", "cf-ipcountry", "host"];
const PHONE = /(?:\+?254|0)[17]\d{8}/g;

const log = (text: string) => console.log(`[experiment] ${text}`);

function hostOf(): string {
  return config().MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
}

function needCredentials(): MpesaCredentials {
  const credentials = mpesaCredentials();
  if (!credentials) throw new Error("M-Pesa settings are incomplete in the environment.");
  return credentials;
}

async function token(credentials: MpesaCredentials): Promise<string> {
  const basic = Buffer.from(`${credentials.MPESA_CONSUMER_KEY}:${credentials.MPESA_CONSUMER_SECRET}`).toString("base64");
  const response = await fetch(`${hostOf()}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Token request refused (HTTP ${response.status}).`);
  return ((await response.json()) as { access_token: string }).access_token;
}

function passwordFor(credentials: MpesaCredentials, at: Date): { Password: string; Timestamp: string } {
  const Timestamp = toServiceTime(at).replace(/\D/g, "").slice(0, 14);
  return { Password: Buffer.from(`${credentials.MPESA_STK_SHORTCODE}${credentials.MPESA_STK_PASSKEY}${Timestamp}`).toString("base64"), Timestamp };
}

/** The callback URL for this origin. Bogus swaps the signature for one the app cannot have issued. */
function urlFor(origin: string, mode: string): string {
  const reference = newReference();
  process.env.MPESA_CALLBACK_BASE_URL = origin;
  const signed = callbackUrl("stk", reference);
  return mode === "bogus" ? signed.replace(/[0-9a-f]{64}$/, "0".repeat(64)) : signed;
}

function shape(url: string): string {
  return url.replace(/\/[0-9a-f]{32}\//, "/<reference>/").replace(/\/[0-9a-f]{64}$/, "/<signature>");
}

async function push(label: string, origin: string, mode: string, out: string): Promise<void> {
  if (!/^https:\/\/[^/\s]+$/.test(origin) || (mode !== "valid" && mode !== "bogus")) throw new Error("Usage: push <label> <https origin> <valid|bogus> <out.json>");
  const credentials = needCredentials();
  const payer = process.env.MPESA_SANDBOX_PAYER_MSISDN;
  if (!payer) throw new Error("MPESA_SANDBOX_PAYER_MSISDN is not set.");
  const digits = payer.replace(/\D/g, "");
  const phone = toDarajaMsisdn(digits.startsWith("254") ? `0${digits.slice(3)}` : digits);
  const at = new Date();
  const url = urlFor(origin, mode);
  const body = {
    BusinessShortCode: Number(credentials.MPESA_STK_SHORTCODE), ...passwordFor(credentials, at), TransactionType: config().MPESA_STK_TRANSACTION_TYPE,
    Amount: AMOUNT_KSH, PartyA: phone, PartyB: credentials.MPESA_STK_SHORTCODE, PhoneNumber: phone,
    CallBackURL: url, AccountReference: `LFexp${label}`.slice(0, 12), TransactionDesc: "Callback test",
  };
  const response = await fetch(`${hostOf()}/mpesa/stkpush/v1/processrequest`, {
    method: "POST", headers: { Authorization: `Bearer ${await token(credentials)}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const saved = { label, mode, amountKsh: AMOUNT_KSH, sentAt: at.toISOString(), callbackHost: new URL(url).host, callbackPathShape: shape(new URL(url).pathname), httpStatus: response.status, daraja: answer };
  fs.writeFileSync(out, `${JSON.stringify(saved, null, 2)}\n`);
  log(`${label}: HTTP ${response.status}, ResponseCode ${String(answer?.ResponseCode ?? "none")}, callback host ${saved.callbackHost}; written ${out}`);
}

async function query(checkoutRequestId: string): Promise<void> {
  const credentials = needCredentials();
  const at = new Date();
  const response = await fetch(`${hostOf()}/mpesa/stkpushquery/v1/query`, {
    method: "POST", headers: { Authorization: `Bearer ${await token(credentials)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ BusinessShortCode: credentials.MPESA_STK_SHORTCODE, ...passwordFor(credentials, at), CheckoutRequestID: checkoutRequestId }), signal: AbortSignal.timeout(30_000),
  });
  const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  console.log(JSON.stringify({ queriedAt: at.toISOString(), httpStatus: response.status, ResultCode: answer?.ResultCode ?? null, ResultDesc: answer?.ResultDesc ?? null, errorCode: answer?.errorCode ?? null, errorMessage: answer?.errorMessage ?? null }));
}

function listen(port: number, out: string): void {
  http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const headers = Object.fromEntries(KEPT_HEADERS.flatMap((name) => (request.headers[name] ? [[name, String(request.headers[name])]] : [])));
      const record = { receivedAt: new Date().toISOString(), method: request.method, path: shape(request.url ?? ""), headers, body: Buffer.concat(chunks).toString("utf8").replace(PHONE, "<phone>") };
      fs.appendFileSync(out, `${JSON.stringify(record)}\n`);
      console.log(`[listener] ${record.receivedAt} ${record.method} ${record.path}`);
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }));
    });
  }).listen(port, "127.0.0.1", () => log(`listening on 127.0.0.1:${port}, recording to ${out}`));
}

async function main(): Promise<void> {
  const [command, a, b, c, d] = process.argv.slice(2);
  if (command === "listen" && a && b) return listen(Number(a), b);
  if (command === "push" && a && b && c && d) return push(a, b, c, d);
  if (command === "query" && a) return query(a);
  throw new Error("Usage: listen <port> <out.jsonl> | push <label> <origin> <valid|bogus> <out.json> | query <checkoutRequestId>");
}

main().catch((error) => {
  console.error(`[experiment] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
