import fs from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { redactPayload } from "./redact";

/**
 * Writes each real exchange with Daraja to MPESA_CAPTURE_DIR, for the sandbox
 * evidence in docs/chapter5/evidence/mpesa/ (section F). Off unless that
 * variable is set. Everything is redacted before it reaches the disk. A
 * failure to write never affects the payment.
 */
let sequence = 0;

export type Capture = { direction: "request" | "response" | "callback"; label: string; status?: number; payload: unknown };

function fileName(entry: Capture, at: Date): string {
  sequence += 1;
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${String(sequence).padStart(3, "0")}-${entry.label}-${entry.direction}.json`;
}

export function capture(entry: Capture, at: Date = new Date()): void {
  const dir = config().MPESA_CAPTURE_DIR;
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const record = { capturedAt: at.toISOString(), ...entry, payload: redactPayload(entry.payload) };
    fs.writeFileSync(path.join(dir, fileName(entry, at)), `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    console.error("[payments] could not write an evidence capture");
  }
}
