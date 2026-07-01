/**
 * Bridge heartbeat status — lets the app distinguish "SMS sync never
 * connected" from "was working, now isn't" from "working fine".
 */
import { sql } from "drizzle-orm";
import type { Db } from "@/db";

export interface BridgeStatus {
  status: "never" | "stale" | "ok";
  lastSeenAt: string | null; // ISO timestamp, or null if never
}

const STALE_AFTER_MS = 10 * 60 * 1000; // 10 minutes — generous margin over the
// 60s local check + 5min heartbeat throttle (see bridge.py)

export async function getBridgeStatus(db: Db, householdId: string): Promise<BridgeStatus> {
  const res = await db.execute(sql`
    SELECT bh.last_seen_at
    FROM (SELECT 1) AS dummy
    LEFT JOIN bridge_heartbeats bh ON bh.household_id = ${householdId}::uuid
  `);
  const row = (res as unknown as { rows: { last_seen_at: string | null }[] }).rows[0];
  const lastSeenAt = row?.last_seen_at ?? null;
  if (!lastSeenAt) return { status: "never", lastSeenAt: null };

  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  return { status: ageMs > STALE_AFTER_MS ? "stale" : "ok", lastSeenAt };
}
