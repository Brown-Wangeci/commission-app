/**
 * The scoring model was trained on naive local timestamps, so features such
 * as `submission_hour_of_day` assume local wall-clock time. Every timestamp
 * sent to the service is converted to Kenyan time (UTC+3 all year, no
 * daylight saving) and sent without an offset.
 */
const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000;

export function toServiceTime(date: Date): string {
  return new Date(date.getTime() + NAIROBI_OFFSET_MS).toISOString().slice(0, 23);
}
