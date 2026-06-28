import { describe, it, expect, beforeEach, vi } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";
import { eq } from "drizzle-orm";

// Replace the production db singleton with the test db so the route writes
// to fin_test instead of fin_dev. Must be hoisted before the route import.
vi.mock("@/db", () => ({ db: tdb }));

import { POST } from "./route";

const SECRET = process.env.INGEST_SECRET ?? "dev_ingest_secret_change_me_01";

function req(body: unknown, auth = `Bearer ${SECRET}`): Request {
  return new Request("http://localhost/api/ingest/sms", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body),
  });
}

// A real SBI UPI debit body matching the T1_SBI_UPI template (acctKey: SBI:3519).
// The regex captures: last4=3519, amount=525.00, date=05Jun26, refno=207781447224.
const SBI =
  "Dear UPI user A/C X3519 debited by 525.00 on date 05Jun26 trf to EatSure Foodcour Refno 207781447224 If not u? call-1800111109 -SBI";

describe.skipIf(!process.env.TEST_DATABASE_URL)("POST /api/ingest/sms", () => {
  beforeEach(resetDb);

  it("rejects a missing/wrong bearer with 401", async () => {
    const res = await POST(
      req(
        { messages: [{ sender: "x", body: "y", receivedAt: "2026-06-05T10:00:00Z" }] },
        "Bearer wrong",
      ),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await POST(req({ messages: [] }));
    expect(res.status).toBe(400);
  });

  it("parses a known SBI SMS, resolves the account by smsKey, and commits a pending entry", async () => {
    const { bank } = await seedBasics();
    await tdb
      .update(schema.accounts)
      .set({ metadata: { smsKey: "SBI:3519" } })
      .where(eq(schema.accounts.id, bank.id));

    const res = await POST(
      req({ messages: [{ sender: "AD-SBIUPI", body: SBI, receivedAt: "2026-06-05T10:00:00Z" }] }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.committed).toBe(1);

    const entries = await tdb
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.accountId, bank.id));
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("pending");
    expect(entries[0].amount).toBe("-525.0000");
    expect(entries[0].source).toBe("import");
  });

  it("records an unparsed financial SMS as a sms_unparsed anomaly (never dropped)", async () => {
    await seedBasics();
    const res = await POST(
      req({
        messages: [{ sender: "PROMO", body: "Win a free iPhone now!", receivedAt: "2026-06-05T10:00:00Z" }],
      }),
    );
    const json = await res.json();
    expect(json.unparsed).toBe(1);
    const anomalies = await tdb
      .select()
      .from(schema.ledgerAnomalies)
      .where(eq(schema.ledgerAnomalies.kind, "sms_unparsed"));
    expect(anomalies.length).toBe(1);
  });

  it("records a parsed-but-unmapped account as a sms_unmapped anomaly", async () => {
    await seedBasics(); // no account has smsKey "SBI:3519"
    const res = await POST(
      req({ messages: [{ sender: "AD-SBIUPI", body: SBI, receivedAt: "2026-06-05T10:00:00Z" }] }),
    );
    const json = await res.json();
    expect(json.unmapped).toBe(1);
    expect(json.committed).toBe(0);
    const anomalies = await tdb
      .select()
      .from(schema.ledgerAnomalies)
      .where(eq(schema.ledgerAnomalies.kind, "sms_unmapped"));
    expect(anomalies.length).toBe(1);
  });

  it("dedupes a re-sent identical SMS (second post commits nothing new)", async () => {
    const { bank } = await seedBasics();
    await tdb
      .update(schema.accounts)
      .set({ metadata: { smsKey: "SBI:3519" } })
      .where(eq(schema.accounts.id, bank.id));

    const msg = {
      messages: [{ sender: "AD-SBIUPI", body: SBI, receivedAt: "2026-06-05T10:00:00Z" }],
    };
    await POST(req(msg));
    const res2 = await POST(req(msg));
    const json2 = await res2.json();
    expect(json2.committed).toBe(0);
    expect(json2.duplicates).toBe(1);

    const entries = await tdb
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.accountId, bank.id));
    expect(entries).toHaveLength(1);
  });
});
