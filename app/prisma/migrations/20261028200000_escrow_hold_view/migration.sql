-- Issue #5: escrow hold state is derived from the activation state, never
-- stored, so the two cannot drift apart. Changing an activation's state
-- changes what this view reports for its hold with no second write.
CREATE VIEW "EscrowHoldState" AS
SELECT
  h.id               AS "holdId",
  h."assignmentId"   AS "assignmentId",
  asg."jobId"        AS "jobId",
  asg."agentId"      AS "agentId",
  h."amountKsh"      AS "amountKsh",
  h."createdAt"      AS "createdAt",
  a.id               AS "activationId",
  a.state            AS "activationState",
  CASE
    WHEN a.id IS NULL THEN 'reserved'
    WHEN a.state = 'approved' THEN 'released'
    WHEN a.state IN ('refused', 'withdrawn') THEN 'returned'
    ELSE 'held'
  END                AS "state"
FROM "EscrowHold" h
JOIN "Assignment" asg ON asg.id = h."assignmentId"
LEFT JOIN "Activation" a ON a."assignmentId" = h."assignmentId";
