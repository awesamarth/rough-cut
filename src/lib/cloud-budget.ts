/** Atomic fail-closed admission. Limits cover this app, not other account usage or all billing dimensions. */
export const RESERVE_CLOUD_USAGE = `INSERT INTO cloud_usage (day, operation, units, requests)
SELECT ?, ?, ?, 1 WHERE ? <= ? AND ? > 0
ON CONFLICT(day, operation) DO UPDATE SET units = units + excluded.units, requests = requests + 1
WHERE units + excluded.units <= ? AND requests < ?
RETURNING units`;

export async function reserveCloudUsage(db: D1Database, operation: string, units: number, limit: number, maxRequests: number) {
  if (![units, limit, maxRequests].every(Number.isSafeInteger) || units <= 0 || limit <= 0 || maxRequests <= 0) return false;
  const day = new Date().toISOString().slice(0, 10);
  return !!await db.prepare(RESERVE_CLOUD_USAGE)
    .bind(day, operation, units, units, limit, maxRequests, limit, maxRequests).first();
}
