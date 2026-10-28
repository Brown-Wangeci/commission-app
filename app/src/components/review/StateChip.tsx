import type { ActivationState, ScoringMode } from "@prisma/client";
import { stateChipClass, stateLabel } from "@/lib/activations/states";

export function StateChip({ state }: { state: ActivationState }) {
  return <span className={`chip ${stateChipClass(state)}`}>{stateLabel(state)}</span>;
}

export function UnscoredChip({ stage }: { stage: ScoringMode | null }) {
  if (!stage) return null;
  return <span className="chip failure">Could not be scored ({stage.toUpperCase()})</span>;
}
