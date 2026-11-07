import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local HTTP server standing in for Daraja, shaped from the v3 documentation.
 * It behaves as documented by default, including refusing a repeated
 * OriginatorConversationID, and a test can script any other reply.
 */
export type DarajaCall = { path: string; body: Record<string, string | number>; authorization: string | null };
export type DarajaReply = { status: number; body: unknown; delayMs?: number; destroy?: boolean };
/** Return a reply to override the default for this call, or undefined to keep it. */
export type DarajaHandler = (call: DarajaCall) => DarajaReply | undefined;

export const PATHS = {
  token: "/oauth/v1/generate",
  stk: "/mpesa/stkpush/v1/processrequest",
  stkQuery: "/mpesa/stkpushquery/v1/query",
  b2c: "/mpesa/b2c/v3/paymentrequest",
  status: "/mpesa/transactionstatus/v1/query",
} as const;

export type FakeDaraja = {
  url: string;
  calls: DarajaCall[];
  callsTo: (path: string) => DarajaCall[];
  setHandler: (handler: DarajaHandler) => void;
  reset: () => void;
  close: () => Promise<void>;
};

type Accepted = { originators: Set<string>; counter: number };

function acceptB2c(state: Accepted, call: DarajaCall): DarajaReply {
  const id = String(call.body.OriginatorConversationID);
  if (state.originators.has(id)) {
    return { status: 500, body: { requestId: "fake", errorCode: "500.002.1001", errorMessage: "Duplicate OriginatorConversationID." } };
  }
  state.originators.add(id);
  state.counter += 1;
  return {
    status: 200,
    body: { ConversationID: `AG_FAKE_${state.counter}`, OriginatorConversationID: id, ResponseCode: "0", ResponseDescription: "Accept the service request successfully." },
  };
}

function defaultReply(state: Accepted, call: DarajaCall): DarajaReply {
  state.counter += 1;
  if (call.path === PATHS.token) return { status: 200, body: { access_token: "fake-token", expires_in: "3599" } };
  if (call.path === PATHS.b2c) return acceptB2c(state, call);
  if (call.path === PATHS.stk) {
    return { status: 200, body: { MerchantRequestID: `m-${state.counter}`, CheckoutRequestID: `ws_CO_FAKE_${state.counter}`, ResponseCode: "0", ResponseDescription: "Success. Request accepted for processing", CustomerMessage: "Success. Request accepted for processing" } };
  }
  if (call.path === PATHS.stkQuery) return { status: 200, body: { ResponseCode: "0", ResponseDescription: "accepted", ResultCode: "1032", ResultDesc: "Request cancelled by user" } };
  return { status: 200, body: { ConversationID: `AG_STATUS_${state.counter}`, OriginatorConversationID: `q-${state.counter}`, ResponseCode: "0", ResponseDescription: "Accept the service request successfully." } };
}

function send(res: http.ServerResponse, req: http.IncomingMessage, reply: DarajaReply): void {
  if (reply.destroy) {
    req.socket.destroy();
    return;
  }
  setTimeout(() => {
    if (res.destroyed) return;
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  }, reply.delayMs ?? 0);
}

export async function startFakeDaraja(): Promise<FakeDaraja> {
  const state: Accepted = { originators: new Set(), counter: 0 };
  const calls: DarajaCall[] = [];
  let handler: DarajaHandler = () => undefined;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const call: DarajaCall = { path: (req.url ?? "").split("?")[0], body: raw ? JSON.parse(raw) : {}, authorization: req.headers.authorization ?? null };
      calls.push(call);
      send(res, req, handler(call) ?? defaultReply(state, call));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    callsTo: (path) => calls.filter((call) => call.path === path),
    setHandler: (next) => (handler = next),
    reset: () => {
      calls.length = 0;
      handler = () => undefined;
      state.originators.clear();
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
