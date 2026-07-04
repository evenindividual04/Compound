"use server";

import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { requireHousehold } from "@/lib/current";
import { parseSmsRows } from "@/lib/import/sms";
import { stageImport, commitImport } from "@/lib/import/pipeline";

/**
 * Re-parses a stored sms_unmapped anomaly's raw SMS and commits it to the
 * chosen account, using the same parseSmsRows/stageImport/commitImport path
 * the ingest route uses — guarantees identical parsing and dedup behavior,
 * no drift. Never drops the anomaly: any failure leaves it open (spec §5).
 */
export async function resolveUnmappedAnomaly(
  anomalyId: string,
  accountId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { householdId } = await requireHousehold();

    const [anomaly] = await db
      .select()
      .from(schema.ledgerAnomalies)
      .where(eq(schema.ledgerAnomalies.id, anomalyId));
    if (!anomaly || anomaly.kind !== "sms_unmapped" || anomaly.resolvedAt !== null) {
      return { ok: false, error: "Anomaly not found or already resolved" };
    }

    const [account] = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.householdId, householdId)));
    if (!account) {
      return { ok: false, error: "Account not found or unauthorized" };
    }

    const detail = anomaly.detail as {
      sender?: string;
      body?: string;
      receivedAt?: string;
    };
    if (!detail.sender || !detail.body || !detail.receivedAt) {
      return { ok: false, error: "This message doesn't have enough stored detail to resolve" };
    }

    const { parsed } = parseSmsRows([
      { sender: detail.sender, body: detail.body, receivedAt: detail.receivedAt },
    ]);
    if (parsed.length !== 1) {
      return { ok: false, error: "Could not re-parse this message — the format may have changed" };
    }

    const filename = `sms-resolve:${new Date().toISOString().slice(0, 10)}`;
    const { importId } = await stageImport(db, {
      householdId,
      accountId,
      filename,
      rows: [parsed[0].row],
    });
    await commitImport(db, importId, householdId);

    await db
      .update(schema.ledgerAnomalies)
      .set({ resolvedAt: new Date() })
      .where(eq(schema.ledgerAnomalies.id, anomalyId));

    return { ok: true };
  } catch (err) {
    console.error("resolveUnmappedAnomaly failed:", err);
    return { ok: false, error: "Couldn't resolve this message. Try again or check the logs." };
  }
}
