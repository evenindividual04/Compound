import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import { stageImport, commitImport } from "./pipeline";
import { parseSmsRows, normalizeMerchant, type RawSms } from "./sms";

// Fixtures are the owner's real SMS shapes (spec §6). The bridge sends raw
// { sender, body, receivedAt }; parsing is server-side so templates live here.

const sbiDebit: RawSms = {
  sender: "AD-SBIUPI",
  body: "Dear UPI user A/C X3519 debited by 525.00 on date 05Jun26 trf to EatSure Foodcour Refno 207781447224 If not u? call-1800111109 -SBI",
  receivedAt: "2026-06-05T13:20:00.000Z",
};

const iciciCard: RawSms = {
  sender: "JM-ICICIB",
  body: "INR 631.83 spent using ICICI Bank Card XX1004 on 11-Jun-26 on PTM*ZOMATO LIMI. Avl Limit: INR 8,997.77. To dispute call 18002662",
  receivedAt: "2026-06-11T09:00:00.000Z",
};

const lazyPay: RawSms = {
  sender: "VM-LAZYPAY",
  body: "Dear LazyPay Customer, your payment of Rs. 651.00 for txn TXN581372203 on Swiggy was successful. Pay by 18th June, 2026 using https://lazypay.in/pay",
  receivedAt: "2026-06-12T18:30:00.000Z",
};

describe("parseSmsRows — T1 SBI UPI debit", () => {
  it("extracts a signed-negative debit row with the UPI Refno as externalId", () => {
    const { parsed, unparsed } = parseSmsRows([sbiDebit]);
    expect(unparsed).toHaveLength(0);
    expect(parsed).toHaveLength(1);
    const p = parsed[0];
    expect(p.acctKey).toBe("SBI:3519");
    expect(p.template).toBe("SBI_UPI_DEBIT");
    expect(p.row.amount).toBe("-525.0000");
    expect(p.row.date).toBe("2026-06-05");
    expect(p.row.description).toBe("EatSure Foodcour");
    expect(p.row.externalId).toBe("207781447224"); // gold dedup key
    expect(p.row.balance).toBeUndefined();
    expect(p.dueDate).toBeUndefined();
  });
});

describe("parseSmsRows — T2 ICICI credit-card spend", () => {
  it("books the spend on the liability account, normalizes merchant, no externalId", () => {
    const { parsed, unparsed } = parseSmsRows([iciciCard]);
    expect(unparsed).toHaveLength(0);
    expect(parsed).toHaveLength(1);
    const p = parsed[0];
    expect(p.acctKey).toBe("ICICI-CC:1004");
    expect(p.template).toBe("ICICI_CC_SPEND");
    expect(p.row.amount).toBe("-631.8300");
    expect(p.row.date).toBe("2026-06-11");
    expect(p.row.description).toBe("Zomato"); // PTM* prefix + LIMI suffix stripped, aliased
    expect(p.row.externalId).toBeUndefined(); // hash dedup fallback
    expect(p.row.balance).toBeUndefined(); // "Avl Limit" is NOT a running balance
  });
});

describe("parseSmsRows — T3 LazyPay BNPL spend", () => {
  it("dates from receivedAt (IST), carries a dueDate, no externalId", () => {
    const { parsed, unparsed } = parseSmsRows([lazyPay]);
    expect(unparsed).toHaveLength(0);
    expect(parsed).toHaveLength(1);
    const p = parsed[0];
    expect(p.acctKey).toBe("LazyPay");
    expect(p.template).toBe("LAZYPAY_SPEND");
    expect(p.row.amount).toBe("-651.0000");
    // 2026-06-12T18:30Z = 2026-06-13T00:00 IST → IST date is the 13th
    expect(p.row.date).toBe("2026-06-13");
    expect(p.row.description).toBe("Swiggy");
    expect(p.row.externalId).toBeUndefined();
    expect(p.dueDate).toBe("2026-06-18");
  });
});

describe("parseSmsRows — multiple & unparsed", () => {
  it("parses a mixed batch and routes unknown financial formats to unparsed (never dropped)", () => {
    const mystery: RawSms = {
      sender: "AX-HDFCBK",
      body: "Your HDFC Bank account has a new statement available. Login to view.",
      receivedAt: "2026-06-12T10:00:00.000Z",
    };
    const { parsed, unparsed } = parseSmsRows([sbiDebit, iciciCard, lazyPay, mystery]);
    expect(parsed).toHaveLength(3);
    expect(unparsed).toHaveLength(1);
    expect(unparsed[0].sender).toBe("AX-HDFCBK");
  });

  it("is order-independent: each template detects its own format", () => {
    const { parsed } = parseSmsRows([lazyPay, sbiDebit, iciciCard]);
    expect(parsed.map((p) => p.template)).toEqual([
      "LAZYPAY_SPEND",
      "SBI_UPI_DEBIT",
      "ICICI_CC_SPEND",
    ]);
  });
});

// Integration: parser output flows through the real pipeline (where dedup lives).
// Verifies the spec's key claim — the same UPI txn arriving later in the statement
// books exactly once, via the UPI Refno as externalId (§7, checklist).
describe.skipIf(!process.env.TEST_DATABASE_URL)("sms rows through the import pipeline", () => {
  let s: Awaited<ReturnType<typeof seedBasics>>;
  beforeEach(async () => {
    await resetDb();
    s = await seedBasics();
  });

  it("SBI UPI debit books once, then dedupes against the later statement (externalId)", async () => {
    const { parsed } = parseSmsRows([sbiDebit]);
    const rows = parsed.map((p) => p.row);

    // 1) SMS arrives in real time → stages + commits one entry.
    const sms = await stageImport(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      filename: "sms:2026-06-05",
      rows,
    });
    expect(sms.stats.total).toBe(1);
    const smsCommit = await commitImport(tdb, sms.importId, s.hh.id);
    expect(smsCommit.created).toBe(1);

    // 2) The same txn later arrives in the SBI statement (same Refno + amount).
    const stmt = await stageImport(tdb, {
      householdId: s.hh.id,
      accountId: s.bank.id,
      filename: "sbi-statement.csv",
      rows,
    });
    expect(stmt.stats.duplicates).toBe(1);
    const stmtCommit = await commitImport(tdb, stmt.importId, s.hh.id);
    expect(stmtCommit.created).toBe(0); // booked once, not twice
  });
});

describe("normalizeMerchant", () => {
  it("strips aggregator prefixes, corp suffixes, and title-cases ALL-CAPS tokens", () => {
    expect(normalizeMerchant("PTM*ZOMATO LIMI")).toBe("Zomato");
    expect(normalizeMerchant("UPI/SWIGGY LIMITED")).toBe("Swiggy");
    expect(normalizeMerchant("EatSure Foodcour")).toBe("EatSure Foodcour"); // mixed case preserved
    expect(normalizeMerchant("  BIGBASKET   ")).toBe("Bigbasket");
  });
});
