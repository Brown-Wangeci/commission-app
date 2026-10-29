"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { postJson } from "@/lib/client-api";
import { formatCents } from "@/lib/money/cents";
import type { PayoutAmountView } from "@/lib/payouts/amount";

type Action = "approve" | "request-evidence" | "refuse";

type Props = {
  activationId: string;
  stateLabel: string;
  amount: PayoutAmountView | null;
  payoutMsisdn: string;
  canApprove: boolean;
  canRefuse: boolean;
  canRequestEvidence: boolean;
  nextId: string | null;
  closingLine: string;
};

const FORM_TEXT: Record<Action, { label: string; hint: string; submit: string }> = {
  approve: {
    label: "Why are you approving?",
    hint: "Shared with the agent and the client.",
    submit: "Approve and pay",
  },
  "request-evidence": {
    label: "What should the agent send?",
    hint: "The agent is notified and sees exactly this text. The submission returns to the queue when they respond.",
    submit: "Send the request",
  },
  refuse: {
    label: "Why are you rejecting?",
    hint: "Shared with the agent and the client. The agent can contest a rejection once.",
    submit: "Reject",
  },
};

/**
 * "Approving pays ...", the commission with its derivation line (from the
 * job's commission structure before approval, from the stored commission
 * record after), and the three decisions.
 */
export function PayoutPanel(props: Props) {
  const router = useRouter();
  const [open, setOpen] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const decidable = props.canApprove || props.canRefuse || props.canRequestEvidence;

  useEffect(() => {
    if (window.location.hash === "#decide-ask" && props.canRequestEvidence) setOpen("request-evidence");
  }, [props.canRequestEvidence]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!open) return;
    setBusy(true);
    setError(null);
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
    const result = await postJson(`/api/admin/review/${props.activationId}/${open}`, { reason });
    setBusy(false);
    if (!result.ok) {
      setError(result.fieldErrors.reason ?? result.message);
      return;
    }
    router.push(props.nextId ? `/admin/review/${props.nextId}` : "/admin/review");
    router.refresh();
  }

  return (
    <section className="card card-pad payout-panel target" id="decide" aria-labelledby="payout-heading">
      <h2 id="payout-heading" className="pays" style={{ fontWeight: 500 }}>
        Approving pays <span className="mono" style={{ color: "var(--ink)" }}>{props.payoutMsisdn}</span>
      </h2>
      <div className="amount">{props.amount ? formatCents(props.amount.amountCents) : "Amount unavailable"}</div>
      {props.amount && (
        <span className="derivation">
          {props.amount.commission.derivation}
          {props.amount.basis === "recorded" ? " (commission recorded at approval)" : ""}
        </span>
      )}
      {!decidable && <p className="small muted" style={{ marginTop: 8 }}>This submission is {props.stateLabel.toLowerCase()}; there is nothing to decide here.</p>}
      {decidable && (
        <div className="decide-buttons" id="decide-ask">
          <button type="button" className="btn primary" disabled={!props.canApprove} onClick={() => setOpen("approve")}>Approve &amp; pay</button>
          <button
            type="button"
            className="btn"
            disabled={!props.canRequestEvidence}
            title={props.canRequestEvidence ? undefined : "Evidence can be requested only while a submission is in review, not during a dispute."}
            onClick={() => setOpen("request-evidence")}
          >
            Ask for evidence
          </button>
          <button type="button" className="btn danger" disabled={!props.canRefuse} onClick={() => setOpen("refuse")}>Reject</button>
        </div>
      )}
      {open && (
        <form className="stack" style={{ marginTop: 14 }} onSubmit={submit}>
          <div className="field">
            <label htmlFor="reason">{FORM_TEXT[open].label}</label>
            <textarea id="reason" name="reason" className="textarea" required minLength={5} maxLength={2000} autoFocus />
            <span className="hint">{FORM_TEXT[open].hint}</span>
          </div>
          {error && <div className="alert error" role="alert">{error}</div>}
          <div className="row">
            <button type="submit" className={`btn ${open === "refuse" ? "danger" : "primary"}`} disabled={busy}>
              {busy ? "Saving" : FORM_TEXT[open].submit}
            </button>
            <button type="button" className="btn" onClick={() => setOpen(null)} disabled={busy}>Cancel</button>
          </div>
        </form>
      )}
      <p className="closing">{props.closingLine}</p>
    </section>
  );
}
