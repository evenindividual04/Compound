import { describe, it, expect, beforeEach } from "vitest";
import { and, eq, gte } from "drizzle-orm";
import { tdb, resetDb, seedBasics } from "./test-db";
import * as schema from "@/db/schema";
import { createTransaction } from "./write";
import { computeBalanceAt, rebuildBalances, netWorth, holdingValueAt } from "./derive";

describe.skipIf(!process.env.TEST_DATABASE_URL)("balance derivation", () => {
  let s: Awaited<ReturnType<typeof seedBasics>>;
  beforeEach(async () => {
    await resetDb();
    s = await seedBasics(); // bank opens 2026-01-01 with 1000
  });

  it("balance = opening + Σ posted entries; pending excluded", async () => {
    await createTransaction(tdb, { accountId: s.bank.id, date: "2026-04-02", amount: "-342" });
    await createTransaction(tdb, {
      accountId: s.bank.id,
      date: "2026-04-03",
      amount: "500",
      status: "pending",
    });
    expect(await computeBalanceAt(tdb, s.bank.id, "2026-04-03")).toBe("658.0000");
  });

  it("liability runs negative: purchase decreases, payment leg increases", async () => {
    await createTransaction(tdb, { accountId: s.card.id, date: "2026-04-05", amount: "-4500" });
    expect(await computeBalanceAt(tdb, s.card.id, "2026-04-05")).toBe("-4500.0000");
    await createTransaction(tdb, { accountId: s.card.id, date: "2026-04-20", amount: "4500" });
    expect(await computeBalanceAt(tdb, s.card.id, "2026-04-20")).toBe("0.0000");
  });

  it("rebuildBalances writes a contiguous daily series with LOCF gaps", async () => {
    await createTransaction(tdb, { accountId: s.bank.id, date: "2026-04-01", amount: "-100" });
    await createTransaction(tdb, { accountId: s.bank.id, date: "2026-04-04", amount: "-50" });
    await rebuildBalances(tdb, s.bank.id, "2026-04-01");

    const rows = await tdb
      .select()
      .from(schema.balances)
      .where(and(eq(schema.balances.accountId, s.bank.id), gte(schema.balances.date, "2026-04-01")))
      .orderBy(schema.balances.date);
    const byDate = Object.fromEntries(rows.map((r) => [r.date, r.balance]));
    expect(byDate["2026-04-01"]).toBe("900.0000");
    expect(byDate["2026-04-02"]).toBe("900.0000"); // LOCF
    expect(byDate["2026-04-03"]).toBe("900.0000"); // LOCF
    expect(byDate["2026-04-04"]).toBe("850.0000");
    // contiguous through today
    const dates = rows.map((r) => r.date);
    expect(new Set(dates).size).toBe(dates.length);
    expect(dates.at(-1)! >= "2026-06-01").toBe(true);
  });

  it("backdated entry: rebuild from its date fixes forward, leaves earlier rows untouched", async () => {
    await createTransaction(tdb, { accountId: s.bank.id, date: "2026-04-01", amount: "-100" });
    await rebuildBalances(tdb, s.bank.id, "2026-04-01");
    const before = await tdb
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.accountId, s.bank.id))
      .orderBy(schema.balances.date);

    // statement import adds a transaction from 3 days later than day 1
    await createTransaction(tdb, { accountId: s.bank.id, date: "2026-04-03", amount: "-200" });
    await rebuildBalances(tdb, s.bank.id, "2026-04-03");

    const after = await tdb
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.accountId, s.bank.id))
      .orderBy(schema.balances.date);
    const byDateBefore = Object.fromEntries(before.map((r) => [r.date, r.balance]));
    const byDateAfter = Object.fromEntries(after.map((r) => [r.date, r.balance]));
    expect(byDateAfter["2026-04-01"]).toBe(byDateBefore["2026-04-01"]); // untouched
    expect(byDateAfter["2026-04-02"]).toBe(byDateBefore["2026-04-02"]); // untouched
    expect(byDateAfter["2026-04-03"]).toBe("700.0000"); // 900 − 200
    expect(byDateAfter["2026-04-04"]).toBe("700.0000");
  });

  it("rebuild is idempotent", async () => {
    await createTransaction(tdb, { accountId: s.bank.id, date: "2026-04-01", amount: "-100" });
    await rebuildBalances(tdb, s.bank.id, "2026-04-01");
    const a = await tdb
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.accountId, s.bank.id))
      .orderBy(schema.balances.date);
    await rebuildBalances(tdb, s.bank.id, "2026-04-01");
    const b = await tdb
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.accountId, s.bank.id))
      .orderBy(schema.balances.date);
    expect(b).toEqual(a);
  });

  it("netWorth sums included active accounts only", async () => {
    await createTransaction(tdb, { accountId: s.bank.id, date: "2026-04-02", amount: "-342" });
    await createTransaction(tdb, { accountId: s.epf.id, date: "2026-04-05", amount: "28000" });
    await createTransaction(tdb, { accountId: s.card.id, date: "2026-04-06", amount: "-45000" });
    // an excluded account must not count
    const [excluded] = await tdb
      .insert(schema.accounts)
      .values({
        householdId: s.hh.id,
        name: "Excluded",
        kind: "bank",
        excluded: true,
        openingBalance: "999999",
        openingDate: "2026-01-01",
      })
      .returning();
    void excluded;
    // 1000 − 342 + 28000 − 45000 = −16342
    expect(await netWorth(tdb, s.hh.id, "2026-04-30")).toBe("-16342.0000");
  });

  it("net worth values investment accounts by holdings × price, not cash flows", async () => {
    const { hh } = s; // bank opens at 1000
    const [zerodha] = await tdb
      .insert(schema.accounts)
      .values({ householdId: hh.id, name: "Zerodha", kind: "investment", openingDate: "2026-01-01" })
      .returning();
    const [inst] = await tdb
      .insert(schema.instruments)
      .values({ householdId: hh.id, kind: "mf", name: "PPFC", amfiCode: "122639" })
      .returning();
    const { createTrade } = await import("@/lib/invest/trade");
    await createTrade(tdb, { accountId: zerodha.id, instrumentId: inst.id, date: "2026-02-01", side: "buy", units: "100", price: "60" });
    await tdb.insert(schema.prices).values({ instrumentId: inst.id, date: "2026-02-28", nav: "75" });

    const value = await holdingValueAt(tdb, zerodha.id, "2026-03-01");
    expect(value).toBe("7500.0000"); // 100 × 75, NOT −6000

    const nw = await netWorth(tdb, hh.id, "2026-03-01");
    expect(nw).toBe("8500.0000"); // bank 1000 + holdings 7500
  });
});
