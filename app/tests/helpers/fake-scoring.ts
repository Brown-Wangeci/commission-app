import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ScoreRequestPayload } from "@/lib/scoring/contract";
import { fakeResponse } from "./responses";

export type FakeReply = { status: number; body: unknown; delayMs?: number; destroy?: boolean };
export type FakeHandler = (request: ScoreRequestPayload) => FakeReply;

export type FakeScoring = {
  url: string;
  requests: ScoreRequestPayload[];
  setHandler: (handler: FakeHandler) => void;
  close: () => Promise<void>;
};

/** Replies like the real service, with a chosen band and probability. */
export function replyWith(band: "auto_release" | "review" | "reject", probability: number): FakeHandler {
  return (request) => ({
    status: 200,
    body: fakeResponse({
      activation_id: request.activation.activation_id,
      mode: request.mode,
      band,
      calibrated_probability: probability,
    }),
  });
}

/** A local HTTP server standing in for the scoring service. */
export async function startFakeScoring(initial: FakeHandler = replyWith("review", 0.42)): Promise<FakeScoring> {
  let handler = initial;
  const requests: ScoreRequestPayload[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as ScoreRequestPayload;
      requests.push(body);
      const reply = handler(body);
      if (reply.destroy) {
        req.socket.destroy();
        return;
      }
      setTimeout(() => {
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setHandler: (next) => (handler = next),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
