/**
 * POST /api/ingest/sms — machine-caller endpoint for the local Mac SMS bridge.
 *
 * Auth: Bearer ${INGEST_SECRET}, timing-safe (same shape as /api/cron/invariants).
 * Flow: parse SMS server-side (templates live in the repo) → resolve acctKey→accountId
 * via accounts.metadata.smsKey → stage + commit through the existing import pipeline →
 * entries land status="pending" in the review inbox. Never moves money (spec §8).
 *
 * Unparsed (financial sender, no template) and unmapped (no account for acctKey) are
 * recorded to ledger_anomalies — detectable, routed to review, never silently dropped (§5).
 */

import { timingSafeEqual, createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { stageImport, commitImport, type NormalizedRow } from "@/lib/import/pipeline";
import { parseSmsRows, type ParsedSms } from "@/lib/import/sms";

function authorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const RawSmsSchema = z.object({
  sender: z.string().min(1),
  body: z.string().min(1),
  receivedAt: z.string().min(1),
});
const BodySchema = z.object({ messages: z.array(RawSmsSchema).min(0).max(500) });

/** Mirrors invariants.ts insertAnomalies: dedup by canonical-hash, skip if an open row exists. */
async function recordAnomaly(kind: string, detail: Record<string, unknown>): Promise<void> {
  const canonical = JSON.stringify(detail, Object.keys(detail).sort());
  const hash = createHash("sha256").update(canonical).digest("hex");
  const detailJson = JSON.stringify(detail);
  await db.execute(sql`
    INSERT INTO ledger_anomalies (kind, detail_hash, detail)
    SELECT ${kind}, ${hash}, ${detailJson}::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM ledger_anomalies WHERE detail_hash = ${hash} AND resolved_at IS NULL
    )
  `);
}

export async function POST(req: Request) {
  if (!authorized(req.headers.get("authorization"), process.env.INGEST_SECRET)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  try {
    // Single-owner app: resolve the one household (spec §5).
    const [hh] = await db
      .select({ id: schema.households.id })
      .from(schema.households)
      .limit(1);
    if (!hh) {
      return NextResponse.json({ ok: false, error: "No household" }, { status: 500 });
    }
    const householdId = hh.id;

    // Heartbeat: refresh on every authenticated call, including empty-messages
    // pings. Best-effort — a missed heartbeat is cosmetic, must never fail ingestion.
    try {
      await db.execute(sql`
        INSERT INTO bridge_heartbeats (household_id, last_seen_at)
        VALUES (${householdId}::uuid, now())
        ON CONFLICT (household_id) DO UPDATE SET last_seen_at = now()
      `);
    } catch {
      // best-effort — see comment above
    }

    const { parsed, unparsed } = parseSmsRows(body.messages);

    // acctKey → accountId, from accounts.metadata.smsKey (set once per account).
    const accounts = await db
      .select({ id: schema.accounts.id, metadata: schema.accounts.metadata })
      .from(schema.accounts)
      .where(eq(schema.accounts.householdId, householdId));
    const keyToId = new Map<string, string>();
    for (const a of accounts) {
      const k = a.metadata?.smsKey;
      if (k) keyToId.set(k, a.id);
    }

    const byAccount = new Map<string, NormalizedRow[]>();
    const unmapped: ParsedSms[] = [];
    for (const p of parsed) {
      const accountId = keyToId.get(p.acctKey);
      if (!accountId) {
        unmapped.push(p);
        continue;
      }
      const rows = byAccount.get(accountId) ?? [];
      rows.push(p.row);
      byAccount.set(accountId, rows);
    }

    // Stage + commit per account through the existing pipeline (dedup + invariants live there).
    const filename = `sms:${new Date().toISOString().slice(0, 10)}`;
    let staged = 0;
    let committed = 0;
    let duplicates = 0;
    for (const [accountId, rows] of byAccount) {
      const { importId, stats } = await stageImport(db, {
        householdId,
        accountId,
        filename,
        rows,
      });
      const { created } = await commitImport(db, importId, householdId);
      staged += stats.total;
      duplicates += stats.duplicates;
      committed += created;
    }

    // Never drop: persist unknown formats and unmapped accounts for follow-up (§5).
    for (const u of unparsed) {
      await recordAnomaly("sms_unparsed", {
        sender: u.sender,
        body: u.body,
        receivedAt: u.receivedAt,
      });
    }
    for (const p of unmapped) {
      await recordAnomaly("sms_unmapped", {
        acctKey: p.acctKey,
        template: p.template,
        amount: p.row.amount,
        date: p.row.date,
        sender: p.raw.sender,
        body: p.raw.body,
        receivedAt: p.raw.receivedAt,
      });
    }

    return NextResponse.json({
      ok: true,
      staged,
      committed,
      duplicates,
      unparsed: unparsed.length,
      unmapped: unmapped.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Ingest failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
