/**
 * The build check for issue #40: no Float or Decimal column may hold money.
 *
 * Two rules, applied to every field of every model and view in a Prisma
 * schema:
 *   1. A Float or Decimal field must be listed below as not money, with the
 *      reason. An unlisted one fails, so a new fractional column has to be
 *      declared non-monetary on purpose before it can ship.
 *   2. A numeric field whose name looks like money must be an Int whose name
 *      ends in "Cents" (or "Bps" for a rate), so its unit is unambiguous.
 *
 * The same allow-list is used by tests/money-columns.test.ts to check the
 * migrated database, so the schema and the migrations cannot drift apart.
 */

/** "Model.field" for every numeric column that is not money although its type (Float, Decimal) or name could suggest it, and why. */
export const NOT_MONEY: Readonly<Record<string, string>> = {
  "Agent.homeLat": "latitude",
  "Agent.homeLon": "longitude",
  "Job.areaLat": "latitude",
  "Job.areaLon": "longitude",
  "Activation.gpsLat": "latitude",
  "Activation.gpsLon": "longitude",
  "Activation.gpsAccuracyM": "distance in metres",
  "EvidenceItem.gpsLat": "latitude",
  "EvidenceItem.gpsLon": "longitude",
  "EvidenceItem.gpsAccuracyM": "distance in metres",
  "ScoringDecision.rawScore": "model score",
  "ScoringDecision.probability": "calibrated probability",
  "ScoringDecision.releaseThreshold": "probability cut-off",
  "ScoringDecision.rejectThreshold": "probability cut-off",
  "ScoringReason.contribution": "SHAP contribution",
  "CustomerActivityDay.usageMinutes": "minutes of service use",
};

/** Words that make a numeric field's name look like an amount of money. */
export const MONEY_NAME = /amount|ksh|kes|cents|price|payout|commission|fee|balance|deposit|escrow|topup|liability|wage|salary|cost|value/i;

const NUMERIC = new Set(["Int", "BigInt", "Float", "Decimal"]);
const FRACTIONAL = new Set(["Float", "Decimal"]);

export type SchemaField = { model: string; field: string; type: string };

/** Every scalar field of every model and view, with its base type. */
export function schemaFields(schema: string): SchemaField[] {
  const fields: SchemaField[] = [];
  let model: string | null = null;
  for (const raw of schema.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const opened = /^(model|view)\s+(\w+)\s*\{/.exec(line);
    if (opened) {
      model = opened[2];
      continue;
    }
    if (line === "}") {
      model = null;
      continue;
    }
    const field = /^(\w+)\s+(\w+)(\[\])?\??/.exec(line);
    if (model && field && !line.startsWith("@@")) fields.push({ model, field: field[1], type: field[2] });
  }
  return fields;
}

/** Every violation of the two rules, as a sentence each. Empty means the schema passes. */
export function moneyColumnViolations(schema: string): string[] {
  const violations: string[] = [];
  for (const { model, field, type } of schemaFields(schema)) {
    const key = `${model}.${field}`;
    if (FRACTIONAL.has(type) && !(key in NOT_MONEY)) {
      violations.push(`${key} is ${type}. Money must be an Int of cents; any other fractional column must be listed in NOT_MONEY with its reason.`);
      continue;
    }
    if (NUMERIC.has(type) && MONEY_NAME.test(field) && !(key in NOT_MONEY)) {
      const unitNamed = /Cents$/.test(field) || /Bps$/.test(field);
      if (!["Int", "BigInt"].includes(type) || !unitNamed) {
        violations.push(`${key} (${type}) looks like money: it must be an Int named ...Cents (or ...Bps for a rate).`);
      }
    }
  }
  return violations;
}
