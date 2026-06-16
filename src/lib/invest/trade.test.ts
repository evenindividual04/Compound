import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";
import { eq } from "drizzle-orm";
import { createTrade } from "./trade";

async function investAccount(hhId: string) {
  const [a] = await tdb
    .insert(schema.accounts)
    .values({ householdId: hhId, name: "Zerodha", kind: "investment", openingDate: "2026-01-01" })
    .returning();
  return a;
}
async function mfInstrument(hhId: string) {
  const [i] = await tdb
    .insert(schema.instruments)
    .values({ householdId: hhId, kind: "mf", name: "PPFC", amfiCode: "122639" })
    .returning();
  return i;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("createTrade", () => {
  beforeEach(resetDb);

  it("a buy stores a negative cash amount and a trades row", async () => {
    const { hh } = await seedBasics();
    const acct = await investAccount(hh.id);
    const inst = await mfInstrument(hh.id);

    const entryId = await createTrade(tdb, {
      accountId: acct.id, instrumentId: inst.id, date: "2026-02-01",
      side: "buy", units: "100.000000", price: "65.430000",
    });

    const [entry] = await tdb.select().from(schema.entries).where(eq(schema.entries.id, entryId));
    const [tr] = await tdb.select().from(schema.trades).where(eq(schema.trades.entryId, entryId));
    expect(entry.entryType).toBe("trade");
    expect(entry.amount).toBe("-6543.0000");
    expect(tr.side).toBe("buy");
    expect(tr.units).toBe("100.000000");
    const [ev] = await tdb.select().from(schema.entryEvents).where(eq(schema.entryEvents.entryId, entryId));
    expect(ev.field).toBe("created");
  });

  it("a sell stores a positive cash amount", async () => {
    const { hh } = await seedBasics();
    const acct = await investAccount(hh.id);
    const inst = await mfInstrument(hh.id);
    const entryId = await createTrade(tdb, {
      accountId: acct.id, instrumentId: inst.id, date: "2026-03-01",
      side: "sell", units: "10.000000", price: "70.000000",
    });
    const [entry] = await tdb.select().from(schema.entries).where(eq(schema.entries.id, entryId));
    expect(entry.amount).toBe("700.0000");
  });

  it("rejects non-positive units and price", async () => {
    const { hh } = await seedBasics();
    const acct = await investAccount(hh.id);
    const inst = await mfInstrument(hh.id);
    await expect(
      createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-02-01", side: "buy", units: "0", price: "65" }),
    ).rejects.toThrow(/units must be positive/);
  });
});
