import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";

describe.skipIf(!process.env.TEST_DATABASE_URL)("p2 schema", () => {
  beforeEach(resetDb);

  it("inserts an instrument and round-trips numeric strings", async () => {
    const { hh } = await seedBasics();
    const [inst] = await tdb
      .insert(schema.instruments)
      .values({ householdId: hh.id, kind: "mf", name: "Parag Parikh Flexi Cap", amfiCode: "122639" })
      .returning();
    expect(inst.kind).toBe("mf");
    expect(inst.amfiCode).toBe("122639");
  });

  it("round-trips trade and price numeric values as exact strings", async () => {
    const { hh } = await seedBasics();
    const [invAccount] = await tdb
      .insert(schema.accounts)
      .values({
        householdId: hh.id,
        name: "Zerodha",
        kind: "investment",
        openingBalance: "0",
        openingDate: "2026-01-01",
      })
      .returning();
    const [inst] = await tdb
      .insert(schema.instruments)
      .values({ householdId: hh.id, kind: "mf", name: "Parag Parikh Flexi Cap", amfiCode: "122639" })
      .returning();
    const [entry] = await tdb
      .insert(schema.entries)
      .values({ accountId: invAccount.id, entryType: "trade", date: "2026-02-01", amount: "80767.13" })
      .returning();
    const [trade] = await tdb
      .insert(schema.trades)
      .values({
        entryId: entry.id,
        instrumentId: inst.id,
        side: "buy",
        units: "1234.567890",
        price: "65.430000",
      })
      .returning();
    expect(trade.side).toBe("buy");
    expect(trade.units).toBe("1234.567890");
    expect(typeof trade.units).toBe("string");
    expect(trade.price).toBe("65.430000");
    expect(typeof trade.price).toBe("string");

    const [price] = await tdb
      .insert(schema.prices)
      .values({ instrumentId: inst.id, date: "2026-02-01", nav: "65.432100" })
      .returning();
    expect(price.nav).toBe("65.432100");
    expect(typeof price.nav).toBe("string");
  });
});
