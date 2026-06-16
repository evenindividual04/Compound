import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";
import { createTrade } from "./trade";
import { computeHoldings } from "./holdings";

async function setup() {
  const { hh } = await seedBasics();
  const [acct] = await tdb
    .insert(schema.accounts)
    .values({ householdId: hh.id, name: "Zerodha", kind: "investment", openingDate: "2026-01-01" })
    .returning();
  const [inst] = await tdb
    .insert(schema.instruments)
    .values({ householdId: hh.id, kind: "mf", name: "PPFC", amfiCode: "122639" })
    .returning();
  return { hh, acct, inst };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("computeHoldings", () => {
  beforeEach(resetDb);

  it("averages cost across buys and reduces units on sells", async () => {
    const { hh, acct, inst } = await setup();
    await createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-02-01", side: "buy", units: "100", price: "60" });
    await createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-02-10", side: "buy", units: "100", price: "80" });
    await createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-03-01", side: "sell", units: "50", price: "90" });

    const holdings = await computeHoldings(tdb, hh.id, "2026-12-31");
    const h = holdings.find((x) => x.instrumentId === inst.id)!;
    expect(h.units).toBe("150.000000");
    expect(h.avgCost).toBe("70.000000");
    expect(h.realizedPnl).toBe("1000.0000");
  });

  it("excludes pending and deleted trades and respects asOf date", async () => {
    const { hh, acct, inst } = await setup();
    await createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-02-01", side: "buy", units: "100", price: "60" });
    await createTrade(tdb, { accountId: acct.id, instrumentId: inst.id, date: "2026-06-01", side: "buy", units: "999", price: "60", status: "pending" });
    const holdings = await computeHoldings(tdb, hh.id, "2026-03-01");
    const h = holdings.find((x) => x.instrumentId === inst.id)!;
    expect(h.units).toBe("100.000000");
  });
});
