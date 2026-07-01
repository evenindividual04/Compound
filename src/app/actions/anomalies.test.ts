import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";

vi.mock("@/db", () => ({ db: tdb }));
vi.mock("@/lib/current", () => ({
  requireHousehold: vi.fn(),
}));

import { requireHousehold } from "@/lib/current";
import { resolveUnmappedAnomaly } from "./anomalies";

const SBI_BODY =
  "Dear UPI user A/C X3519 debited by 525.00 on date 05Jun26 trf to EatSure Foodcour Refno 207781447224 If not u? call-1800111109 -SBI";

describe.skipIf(!process.env.TEST_DATABASE_URL)("resolveUnmappedAnomaly", () => {
  let seeds: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    await resetDb();
    seeds = await seedBasics();
    vi.mocked(requireHousehold).mockResolvedValue({
      userId: "test-user",
      email: "test@example.com",
      householdId: seeds.hh.id,
    });
  });

  it("re-parses the raw SMS, commits a transaction on the chosen account, and resolves the anomaly", async () => {
    const [anomaly] = await tdb
      .insert(schema.ledgerAnomalies)
      .values({
        kind: "sms_unmapped",
        detailHash: "test-hash-resolve-1",
        detail: {
          acctKey: "SBI:3519",
          template: "SBI_UPI_DEBIT",
          amount: "-525.0000",
          date: "2026-06-05",
          sender: "AD-SBIUPI",
          body: SBI_BODY,
          receivedAt: "2026-06-05T10:00:00Z",
        },
      })
      .returning();

    const result = await resolveUnmappedAnomaly(anomaly.id, seeds.bank.id);
    expect(result).toEqual({ ok: true });

    const entries = await tdb
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.accountId, seeds.bank.id));
    expect(entries).toHaveLength(1);
    expect(entries[0].amount).toBe("-525.0000");
    expect(entries[0].status).toBe("pending");

    const [resolved] = await tdb
      .select()
      .from(schema.ledgerAnomalies)
      .where(eq(schema.ledgerAnomalies.id, anomaly.id));
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it("returns an error and leaves the anomaly open if the account doesn't belong to this household", async () => {
    const [otherHousehold] = await tdb
      .insert(schema.households)
      .values({ name: "other" })
      .returning();
    const [otherAccount] = await tdb
      .insert(schema.accounts)
      .values({
        householdId: otherHousehold.id,
        name: "Other Bank",
        kind: "bank",
        openingBalance: "0",
        openingDate: "2026-01-01",
      })
      .returning();

    const [anomaly] = await tdb
      .insert(schema.ledgerAnomalies)
      .values({
        kind: "sms_unmapped",
        detailHash: "test-hash-resolve-2",
        detail: {
          acctKey: "SBI:3519",
          sender: "AD-SBIUPI",
          body: SBI_BODY,
          receivedAt: "2026-06-05T10:00:00Z",
        },
      })
      .returning();

    const result = await resolveUnmappedAnomaly(anomaly.id, otherAccount.id);
    expect(result.ok).toBe(false);

    const [stillOpen] = await tdb
      .select()
      .from(schema.ledgerAnomalies)
      .where(eq(schema.ledgerAnomalies.id, anomaly.id));
    expect(stillOpen.resolvedAt).toBeNull();
  });

  it("returns an error and leaves the anomaly open if the stored body no longer parses", async () => {
    const [anomaly] = await tdb
      .insert(schema.ledgerAnomalies)
      .values({
        kind: "sms_unmapped",
        detailHash: "test-hash-resolve-3",
        detail: {
          acctKey: "SBI:3519",
          sender: "AD-SBIUPI",
          body: "this is not a recognizable transaction format",
          receivedAt: "2026-06-05T10:00:00Z",
        },
      })
      .returning();

    const result = await resolveUnmappedAnomaly(anomaly.id, seeds.bank.id);
    expect(result.ok).toBe(false);

    const [stillOpen] = await tdb
      .select()
      .from(schema.ledgerAnomalies)
      .where(eq(schema.ledgerAnomalies.id, anomaly.id));
    expect(stillOpen.resolvedAt).toBeNull();
  });
});
