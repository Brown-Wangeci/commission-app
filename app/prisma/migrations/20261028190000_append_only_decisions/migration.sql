-- Issue #4: scoring decisions are append-only. A new score adds a row; an
-- existing decision or reason can never be changed or removed, by any client.
CREATE FUNCTION ledgerfield_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledgerfield: % is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ScoringDecision_append_only"
  BEFORE UPDATE OR DELETE ON "ScoringDecision"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_reject_mutation();

CREATE TRIGGER "ScoringReason_append_only"
  BEFORE UPDATE OR DELETE ON "ScoringReason"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_reject_mutation();

CREATE TRIGGER "ScoringAttempt_append_only"
  BEFORE UPDATE OR DELETE ON "ScoringAttempt"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_reject_mutation();
