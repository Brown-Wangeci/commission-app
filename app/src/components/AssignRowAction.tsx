"use client";

import { useState } from "react";
import { AssignAgentForm } from "./AssignAgentForm";

type Props = { jobId: string; jobTitle: string; agents: Array<{ id: string; label: string }> };

/** The Assign action on a row of the jobs list: one button that opens the agent picker in place. */
export function AssignRowAction({ jobId, jobTitle, agents }: Props) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return <button type="button" className="btn small" onClick={() => setOpen(true)} aria-label={`Assign an agent to ${jobTitle}`}>Assign</button>;
  }
  return (
    <div className="stack-sm" style={{ minWidth: 260 }}>
      <AssignAgentForm jobId={jobId} agents={agents} compact />
      <button type="button" className="linkbutton tiny" onClick={() => setOpen(false)}>Close</button>
    </div>
  );
}
