"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { postJson } from "@/lib/client-api";

type Option = { id: string; label: string };

/** Admin control: assign one slot of this job to an agent. */
export function AssignAgentForm({ jobId, agents }: { jobId: string; agents: Option[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const agentId = String(new FormData(event.currentTarget).get("agentId") ?? "");
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await postJson<{ holdKsh: number | null }>(`/api/admin/jobs/${jobId}/assign`, { agentId });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setDone(`Assigned. KSh ${result.data.holdKsh ?? "?"} locked in escrow; the agent can now accept the job.`);
    router.refresh();
  }

  return (
    <form className="stack-sm" onSubmit={submit}>
      <label htmlFor="agentId" className="label">Assign to an agent</label>
      <div className="row wrap">
        <select id="agentId" name="agentId" className="select" style={{ maxWidth: 320 }} required>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
        </select>
        <button type="submit" className="btn primary" disabled={busy || agents.length === 0}>{busy ? "Assigning" : "Assign"}</button>
      </div>
      {error && <span className="field-error">{error}</span>}
      {done && <span className="tiny" style={{ color: "var(--accent)" }}>{done}</span>}
    </form>
  );
}
