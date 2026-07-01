import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "./test-db";
import * as schema from "@/db/schema";
import { createTransaction, createValuation } from "./write";
import { afterWrite } from "./derive";
import {
  monthSpend,
  monthSpendByCategory,
  spendTrend,
  needsAttention,
  recentTransactions,
} from "./dashboard";

describe.skipIf(!process.env.TEST_DATABASE_URL)("dashboard queries", () => {
  let seeds: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    await resetDb();
    seeds = await seedBasics();
  });

  // ── monthSpend ─────────────────────────────────────────────────────────────

  describe("monthSpend", () => {
    it("sums negative rollup amounts for the month", async () => {
      const { bank, food } = seeds;
      await createTransaction(tdb, {
        accountId: bank.id,
        date: "2026-04-10",
        amount: "-500.0000",
        categoryId: food.id,
      });
      await createTransaction(tdb, {
        accountId: bank.id,
        date: "2026-04-20",
        amount: "-200.0000",
        categoryId: food.id,
      });
      await afterWrite(tdb, {
        accountId: bank.id,
        householdId: seeds.hh.id,
        date: "2026-04-10",
      });

      const spend = await monthSpend(tdb, seeds.hh.id, "2026-04-01");
      expect(parseFloat(spend)).toBeCloseTo(700, 2);
    });

    it("excludes income category rollups", async () => {
      const { bank, salary } = seeds;
      await createTransaction(tdb, {
        accountId: bank.id,
        date: "2026-04-05",
        amount: "50000.0000",
        categoryId: salary.id,
      });
      await afterWrite(tdb, {
        accountId: bank.id,
        householdId: seeds.hh.id,
        date: "2026-04-05",
      });

      // Income row is positive — monthSpend should be 0
      const spend = await monthSpend(tdb, seeds.hh.id, "2026-04-01");
      expect(parseFloat(spend)).toBe(0);
    });

    it("returns 0 when no rollup rows exist for the month", async () => {
      const spend = await monthSpend(tdb, seeds.hh.id, "2026-04-01");
      expect(spend).toBe("0.0000");
    });

    it("excludes transfer legs (they are never rolled up)", async () => {
      const { bank, cash } = seeds;
      // Create transfer — neither leg should appear in rollups per derive.ts logic
      const outId = await createTransaction(tdb, {
        accountId: bank.id,
        date: "2026-04-15",
        amount: "-5000.0000",
      });
      const inId = await createTransaction(tdb, {
        accountId: cash.id,
        date: "2026-04-15",
        amount: "5000.0000",
      });
      await tdb.insert(schema.transfers).values({ outflowEntryId: outId, inflowEntryId: inId });
      await afterWrite(tdb, {
        accountId: bank.id,
        householdId: seeds.hh.id,
        date: "2026-04-15",
      });
      await afterWrite(tdb, {
        accountId: cash.id,
        householdId: seeds.hh.id,
        date: "2026-04-15",
      });

      const spend = await monthSpend(tdb, seeds.hh.id, "2026-04-01");
      expect(parseFloat(spend)).toBe(0);
    });
  });

  // ── spendTrend ─────────────────────────────────────────────────────────────

  describe("spendTrend", () => {
    it("returns oldest-first with correct length", async () => {
      const trend = await spendTrend(tdb, seeds.hh.id, 6);
      expect(trend).toHaveLength(6);
      // Must be in ascending order
      for (let i = 1; i < trend.length; i++) {
        expect(trend[i].month >= trend[i - 1].month).toBe(true);
      }
    });

    it("includes a month with spend data", async () => {
      const { bank, food } = seeds;
      // Use the current month so it falls within the 6-month window
      const today = new Date();
      const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-15`;
      await createTransaction(tdb, {
        accountId: bank.id,
        date: thisMonth,
        amount: "-1234.0000",
        categoryId: food.id,
      });
      await afterWrite(tdb, {
        accountId: bank.id,
        householdId: seeds.hh.id,
        date: thisMonth,
      });

      const trend = await spendTrend(tdb, seeds.hh.id, 6);
      const currentMonthKey = thisMonth.slice(0, 7);
      const point = trend.find((p) => p.month === currentMonthKey);
      expect(point).toBeDefined();
      expect(parseFloat(point!.spend)).toBeCloseTo(1234, 2);
    });

    it("fills 0 for months with no data", async () => {
      // No transactions seeded → all trend points should be 0
      const trend = await spendTrend(tdb, seeds.hh.id, 3);
      for (const p of trend) {
        expect(parseFloat(p.spend)).toBe(0);
      }
    });
  });

  // ── needsAttention ─────────────────────────────────────────────────────────

  describe("needsAttention", () => {
    it("counts pending transaction entries in inbox", async () => {
      const { bank } = seeds;
      await createTransaction(tdb, {
        accountId: bank.id,
        date: "2026-04-10",
        amount: "-100.0000",
        status: "pending",
      });

      const result = await needsAttention(tdb, seeds.hh.id);
      expect(result.inbox).toBeGreaterThanOrEqual(1);
    });

    it("detects stale anchor on EPF account (valuation dated 2026-03-01)", async () => {
      const { epf } = seeds;
      // Create a valuation dated 2026-03-01 (> 60 days before 2026-06-11)
      await createValuation(tdb, {
        accountId: epf.id,
        date: "2026-03-01",
        amount: "100000.0000",
        kind: "reconciliation",
      });

      const result = await needsAttention(tdb, seeds.hh.id);
      const stale = result.staleAnchors.find((a) => a.accountId === epf.id);
      expect(stale).toBeDefined();
      expect(stale!.lastAnchor).toBe("2026-03-01");
    });

    it("does NOT flag bank accounts as stale anchors", async () => {
      const { bank } = seeds;
      const result = await needsAttention(tdb, seeds.hh.id);
      const bankStale = result.staleAnchors.find((a) => a.accountId === bank.id);
      expect(bankStale).toBeUndefined();
    });

    it("does NOT flag EPF with a recent valuation as stale", async () => {
      const { epf } = seeds;
      // Use today's date as the valuation date — definitely not stale
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      await createValuation(tdb, {
        accountId: epf.id,
        date: todayStr,
        amount: "200000.0000",
        kind: "reconciliation",
      });

      const result = await needsAttention(tdb, seeds.hh.id);
      const stale = result.staleAnchors.find((a) => a.accountId === epf.id);
      expect(stale).toBeUndefined();
    });

    it("reports open anomalies count", async () => {
      await tdb.insert(schema.ledgerAnomalies).values({
        kind: "test_anomaly",
        detailHash: "abc123",
        detail: { msg: "test" },
      });

      const result = await needsAttention(tdb, seeds.hh.id);
      expect(result.anomalies).toBeGreaterThanOrEqual(1);
    });

    it("reports hasAccounts=false for a household with no accounts", async () => {
      const [bareHousehold] = await tdb
        .insert(schema.households)
        .values({ name: "bare" })
        .returning();
      const result = await needsAttention(tdb, bareHousehold.id);
      expect(result.hasAccounts).toBe(false);
    });

    it("reports hasAccounts=true once seedBasics has run", async () => {
      const result = await needsAttention(tdb, seeds.hh.id);
      expect(result.hasAccounts).toBe(true);
    });

    it("reports bridgeStatus='never' with no heartbeat row", async () => {
      const result = await needsAttention(tdb, seeds.hh.id);
      expect(result.bridgeStatus).toBe("never");
    });

    it("counts open sms_unmapped anomalies in unmappedCount", async () => {
      await tdb.insert(schema.ledgerAnomalies).values({
        kind: "sms_unmapped",
        detailHash: "test-hash-1",
        detail: { acctKey: "SBI:9999" },
      });
      const result = await needsAttention(tdb, seeds.hh.id);
      expect(result.unmappedCount).toBe(1);
    });
  });

  // ── recentTransactions ─────────────────────────────────────────────────────

  describe("recentTransactions", () => {
    it("returns transactions in descending date order, respecting limit", async () => {
      const { bank, food } = seeds;
      // Insert 6 transactions on different dates
      for (let i = 1; i <= 6; i++) {
        await createTransaction(tdb, {
          accountId: bank.id,
          date: `2026-04-${String(i).padStart(2, "0")}`,
          amount: `-${i * 100}.0000`,
          categoryId: food.id,
        });
      }

      const recent = await recentTransactions(tdb, seeds.hh.id, 5);
      expect(recent).toHaveLength(5);
      // First row should be the most recent date
      expect(recent[0].date).toBe("2026-04-06");
      // Last row should be 2026-04-02 (5 newest)
      expect(recent[4].date).toBe("2026-04-02");
    });

    it("excludes pending entries", async () => {
      const { bank } = seeds;
      await createTransaction(tdb, {
        accountId: bank.id,
        date: "2026-04-10",
        amount: "-999.0000",
        status: "pending",
      });

      const recent = await recentTransactions(tdb, seeds.hh.id, 5);
      // Pending entry should not appear
      expect(recent.every((r) => r.amount !== "-999.0000")).toBe(true);
    });

    it("returns empty array when no transactions", async () => {
      const recent = await recentTransactions(tdb, seeds.hh.id, 5);
      expect(recent).toHaveLength(0);
    });
  });
});
