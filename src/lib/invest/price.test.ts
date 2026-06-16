import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";
import { upsertPrices, latestPriceAt } from "./price";

describe.skipIf(!process.env.TEST_DATABASE_URL)("price store", () => {
  beforeEach(resetDb);

  it("upserts idempotently and reads the latest price ≤ date", async () => {
    const { hh } = await seedBasics();
    const [inst] = await tdb.insert(schema.instruments).values({ householdId: hh.id, kind: "mf", name: "PPFC", amfiCode: "122639" }).returning();

    await upsertPrices(tdb, [{ instrumentId: inst.id, date: "2026-06-15", nav: "65.000000" }]);
    await upsertPrices(tdb, [{ instrumentId: inst.id, date: "2026-06-15", nav: "66.000000" }]);
    await upsertPrices(tdb, [{ instrumentId: inst.id, date: "2026-06-16", nav: "67.000000" }]);

    expect(await latestPriceAt(tdb, inst.id, "2026-06-16")).toBe("67.000000");
    expect(await latestPriceAt(tdb, inst.id, "2026-06-15")).toBe("66.000000");
    expect(await latestPriceAt(tdb, inst.id, "2026-06-10")).toBeNull();
    const rows = await tdb.select().from(schema.prices);
    expect(rows.length).toBe(2);
  });
});
