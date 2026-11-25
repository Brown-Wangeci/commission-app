"use client";

import { useEffect, useState } from "react";
import type { AuditRecordEvent } from "@/lib/audit/history";
import type { AuditVerification, EventCheck } from "@/lib/audit/verify";
import { postJson } from "@/lib/client-api";
import { Disclosure } from "@/components/Disclosure";
import { EmptyState } from "@/components/EmptyState";

/** `collapsible` puts the record in a section that opens on click, for screens where it is not the main thing. */
type Props = { apiBase: string; disputed: boolean; collapsible?: boolean };

const STATUS_TEXT: Record<AuditVerification["status"], { chip: string; label: string; tone: string }> = {
  verified: { chip: "approved", label: "Verified on chain", tone: "ok" },
  partly_verified: { chip: "review", label: "Partly verified", tone: "info" },
  failed: { chip: "failure", label: "Verification failed", tone: "error" },
};

function short(hash: string | null): string {
  return hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : "none";
}

function eventLabel(event: AuditRecordEvent): string {
  if (event.kind === "transition") return `${event.fromState ?? "new"} → ${event.toState ?? "?"}`;
  return event.kind.replace(/_/g, " ");
}

function AnchorCell({ anchor }: { anchor: AuditRecordEvent["anchor"] }) {
  if (anchor.state === "anchored") {
    return (
      <>
        <span className="chip approved">Anchored</span>
        <div className="tiny mono">block {anchor.blockNumber}</div>
        <div className="tiny mono">{anchor.txUrl ? <a href={anchor.txUrl} target="_blank" rel="noreferrer">{short(anchor.txHash)}</a> : short(anchor.txHash)}</div>
      </>
    );
  }
  if (anchor.state === "queued") {
    return (
      <>
        <span className={`chip ${anchor.escalated ? "failure" : "review"}`}>{anchor.escalated ? "Anchoring stalled" : "Being anchored"}</span>
        {anchor.lastError && <div className="tiny muted">{anchor.lastError}</div>}
      </>
    );
  }
  return <span className="chip neutral">Waiting for the next batch</span>;
}

function CheckLine({ check }: { check: EventCheck }) {
  const onChain = check.batch?.onChain;
  return (
    <li className="tiny">
      <strong>{check.ok ? "Passes" : "Fails"}</strong>, event {check.eventId} (sequence {check.sequence ?? "none"}): hash {check.hashMatches ? "recomputes" : "does not recompute"}, link {check.linkMatches ? "holds" : "broken"}
      {check.proofValid !== null && <>, Merkle proof {check.proofValid ? "valid" : "invalid"}</>}
      {onChain?.checked && <>, root {onChain.rootOnChain ? "recorded by the contract" : "not on chain"}, transaction {onChain.matchesTransaction ? "matches" : "does not match"}</>}
      {onChain && !onChain.checked && <>, on chain: {onChain.reason}</>}
      {!check.hashMatches && check.storedHash && <div className="mono">stored {short(check.storedHash)}, recomputed {short(check.recomputedHash)}</div>}
    </li>
  );
}

/**
 * A submission's audit record and its independent verification (FR-22),
 * shown on the dispute flow, where it matters most.
 */
export function AuditTrailPanel({ apiBase, disputed, collapsible = false }: Props) {
  const [events, setEvents] = useState<AuditRecordEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AuditVerification | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(apiBase)
      .then(async (response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((body: { events: AuditRecordEvent[] }) => setEvents(body.events))
      .catch(() => setError("The audit record could not be loaded."));
  }, [apiBase]);

  async function verify() {
    setBusy(true);
    setError(null);
    const response = await postJson<AuditVerification>(`${apiBase}/verify`, {});
    setBusy(false);
    if (!response.ok) setError(response.message);
    else setResult(response.data);
  }

  const verifyButton = (
    <button type="button" className="btn" onClick={verify} disabled={busy || !events}>{busy ? "Verifying" : "Verify against the blockchain"}</button>
  );
  const body = (
    <>
      {disputed && (
        <div className="alert info">
          This submission is in dispute. Every change to it is hashed into a chain, and the chain is anchored on the blockchain in batches. Verifying
          recomputes each hash from the stored record and checks it against the root the contract holds, so a record changed after the fact shows here.
        </div>
      )}
      {error && <div className="alert error" role="alert">{error}</div>}
      {result && (
        <div className={`alert ${STATUS_TEXT[result.status].tone}`}>
          <span className={`chip ${STATUS_TEXT[result.status].chip}`}>{STATUS_TEXT[result.status].label}</span> {result.summary}
          <ul className="stack-sm" style={{ marginTop: 8 }}>{result.events.map((check) => <CheckLine key={check.eventId} check={check} />)}</ul>
        </div>
      )}
      {events === null && !error && <p className="small muted">Loading the audit record.</p>}
      {events && events.length === 0 && (
        <EmptyState title="No events recorded" next="Nothing is needed. Events are added by the system as this submission changes.">
          Every change to a submission is recorded here with its hash.
        </EmptyState>
      )}
      {events && events.length > 0 && (
        <div className="table-wrap">
          <table className="table table-cards">
            <thead><tr><th>#</th><th>When</th><th>Event</th><th>Hash</th><th>On chain</th></tr></thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.eventId}>
                  <td data-label="#" className="mono small">{event.sequence ?? "-"}</td>
                  <td data-label="When" className="small num">{new Date(event.at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })}</td>
                  <td data-label="Event" className="small">{eventLabel(event)}{event.detail && <div className="tiny muted">{event.detail}</div>}</td>
                  <td data-label="Hash" className="mono tiny" title={event.hash ?? undefined}>{short(event.hash)}</td>
                  <td data-label="On chain" className="small"><AnchorCell anchor={event.anchor} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
  if (collapsible) {
    return (
      <Disclosure id="audit" title="Audit record" hint="Every change, hashed and checked against the blockchain">
        <div className="stack">
          <div>{verifyButton}</div>
          {body}
        </div>
      </Disclosure>
    );
  }
  return (
    <section className="card card-pad stack" aria-labelledby="audit-heading" id="audit">
      <div className="row wrap" style={{ justifyContent: "space-between" }}>
        <h2 id="audit-heading">Audit record</h2>
        {verifyButton}
      </div>
      {body}
    </section>
  );
}
