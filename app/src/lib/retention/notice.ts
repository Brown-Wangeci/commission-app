/**
 * DR-11, data minimisation at the point of entry. Every form whose text is
 * copied into an audit event's detail shows this. The audit log is
 * append-only and anchored on chain, so anything typed here cannot be
 * removed later by the retention job or by anyone else. There is deliberately
 * no automatic redaction: a silent rewrite of a person's words would damage
 * the accountability record the chain exists to provide.
 */
export const AUDIT_TEXT_NOTICE =
  "Do not include the customer's name, phone number, ID number or other personal details. " +
  "This text is kept permanently in the audit record and cannot be deleted later.";
