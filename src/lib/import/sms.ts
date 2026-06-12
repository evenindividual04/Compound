/**
 * sms.ts — Per-bank SMS transaction templates (spec §6).
 *
 * Pure + DB-free: the bridge sends raw { sender, body, receivedAt }; this module
 * detects the bank/rail, extracts a transaction, and emits an `acctKey` + a
 * NormalizedRow that matches the existing import contract (see pipeline.ts).
 * Account resolution (acctKey → accountId) and persistence happen in the route.
 *
 * Money stays in the string domain end-to-end — never Number() (see money.ts / AGENTS.md).
 * Debits/spend are negative, credits positive (ADR-1 sign convention).
 */

import { parse as parseDateFns, isValid, format } from "date-fns";
import type { NormalizedRow } from "./pipeline";

// ── Public types ────────────────────────────────────────────────────────────

export interface RawSms {
  sender: string; // DLT header / shortcode, e.g. "AD-SBIUPI"
  body: string; // full SMS text
  receivedAt: string; // ISO8601 (when the SMS landed on the Mac)
}

export interface ParsedSms {
  acctKey: string; // "SBI:3519" | "ICICI-CC:1004" | "LazyPay" — resolved to accountId in the route
  template: string; // template id, for traceability
  row: NormalizedRow; // date, signed-4dp amount, description, externalId?
  dueDate?: string; // yyyy-MM-dd — BNPL/CC "pay by" (surfaced later; see open question §11.2)
}

export interface SmsParseResult {
  parsed: ParsedSms[];
  unparsed: RawSms[]; // financial-sender SMS matching no template — recorded, never dropped (§5)
}

// ── Money (string domain, mirrors mapping.ts toFixed4) ──────────────────────

/** "8,997.77" → "-8997.7700" (commas stripped, 4dp, signed). No Number(). */
function toSignedMoney(raw: string, sign: 1 | -1): string {
  const cleaned = raw.replace(/,/g, "").trim();
  const [int, dec = ""] = cleaned.split(".");
  const decimal = (dec + "0000").slice(0, 4);
  const unsigned = `${int}.${decimal}`;
  return sign === -1 ? `-${unsigned}` : unsigned;
}

// ── Dates ───────────────────────────────────────────────────────────────────

const REFERENCE = new Date(2000, 0, 1); // date-fns anchor for 2-digit years

function parseLiteralDate(raw: string, fmt: string): string | null {
  const d = parseDateFns(raw.trim(), fmt, REFERENCE);
  return isValid(d) ? format(d, "yyyy-MM-dd") : null;
}

/** ISO instant → yyyy-MM-dd in IST, independent of the server's local timezone. */
function istDate(iso: string): string {
  const ms = new Date(iso).getTime() + 5.5 * 60 * 60 * 1000; // shift to IST then read UTC parts
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** "18th June, 2026" → "2026-06-18". Strips the ordinal suffix, then date-fns. */
function parseDueDate(raw: string): string | undefined {
  const stripped = raw.replace(/(\d+)(st|nd|rd|th)/i, "$1").replace(",", "").trim();
  return parseLiteralDate(stripped, "dd MMMM yyyy") ?? undefined;
}

// ── Merchant normalization ──────────────────────────────────────────────────

const MERCHANT_ALIASES: Record<string, string> = {
  ZOMATO: "Zomato",
  SWIGGY: "Swiggy",
  EATSURE: "EatSure",
};

const CORP_SUFFIX = /\s+(LIMITED|LIMI|LTD|PVT\s+LTD|PVT)\.?$/i;

function titleCaseToken(token: string): string {
  // Only re-case ALL-CAPS tokens (e.g. "ZOMATO"); preserve deliberate mixed case ("EatSure").
  const isAllCaps = token === token.toUpperCase() && /[A-Z]/.test(token);
  return isAllCaps ? token[0] + token.slice(1).toLowerCase() : token;
}

export function normalizeMerchant(raw: string): string {
  let s = raw.trim();
  if (s.includes("*")) s = s.slice(s.lastIndexOf("*") + 1); // drop aggregator prefix "PTM*"
  if (s.includes("/")) s = s.slice(s.lastIndexOf("/") + 1); // drop "UPI/" style prefix
  s = s.trim();
  while (CORP_SUFFIX.test(s)) s = s.replace(CORP_SUFFIX, ""); // strip trailing " LIMITED"/" LIMI"
  s = s.replace(/\s+/g, " ").trim();

  const alias = MERCHANT_ALIASES[s.toUpperCase()];
  if (alias) return alias;

  return s.split(" ").map(titleCaseToken).join(" ");
}

// ── Templates ───────────────────────────────────────────────────────────────

type Template = (sms: RawSms) => ParsedSms | null;

// T1 — SBI UPI debit (bank account, has UPI Refno → gold dedup key)
const T1_SBI_UPI: Template = (sms) => {
  const m = sms.body.match(
    /A\/C X(\d{4}) debited by ([\d,]+\.\d{2}) on date (\d{2}[A-Za-z]{3}\d{2}) trf to (.+?) Refno (\d+)/,
  );
  if (!m) return null;
  const [, last4, amount, dateRaw, merchant, refno] = m;
  const date = parseLiteralDate(dateRaw, "ddMMMyy");
  if (!date) return null;
  return {
    acctKey: `SBI:${last4}`,
    template: "SBI_UPI_DEBIT",
    row: {
      date,
      amount: toSignedMoney(amount, -1),
      description: normalizeMerchant(merchant),
      externalId: refno,
    },
  };
};

// T2 — ICICI credit-card spend (liability account, no UPI ref → hash dedup)
const T2_ICICI_CC: Template = (sms) => {
  const m = sms.body.match(
    /INR ([\d,]+\.\d{2}) spent using ICICI Bank Card XX(\d{4}) on (\d{2}-[A-Za-z]{3}-\d{2}) on (.+?)\. Avl Limit/,
  );
  if (!m) return null;
  const [, amount, last4, dateRaw, merchant] = m;
  const date = parseLiteralDate(dateRaw, "dd-MMM-yy");
  if (!date) return null;
  return {
    acctKey: `ICICI-CC:${last4}`,
    template: "ICICI_CC_SPEND",
    row: {
      date,
      amount: toSignedMoney(amount, -1),
      description: normalizeMerchant(merchant),
      // no externalId; "Avl Limit" is NOT a running balance → balance omitted (§7)
    },
  };
};

// T3 — LazyPay BNPL spend (liability account + due date; no txn date in body → receivedAt)
const T3_LAZYPAY: Template = (sms) => {
  const m = sms.body.match(
    /payment of Rs\.?\s*([\d,]+\.\d{2}) for txn (\w+) on (.+?) was successful\. Pay by (.+?) using/,
  );
  if (!m) return null;
  const [, amount, , merchant, dueRaw] = m;
  return {
    acctKey: "LazyPay",
    template: "LAZYPAY_SPEND",
    row: {
      date: istDate(sms.receivedAt),
      amount: toSignedMoney(amount, -1),
      description: normalizeMerchant(merchant),
      // no externalId (BNPL txnId doesn't reconcile to the statement → hash dedup, §7)
    },
    dueDate: parseDueDate(dueRaw),
  };
};

const TEMPLATES: Template[] = [T1_SBI_UPI, T2_ICICI_CC, T3_LAZYPAY];

// ── Entry point ─────────────────────────────────────────────────────────────

export function parseSmsRows(messages: RawSms[]): SmsParseResult {
  const parsed: ParsedSms[] = [];
  const unparsed: RawSms[] = [];

  for (const sms of messages) {
    let matched: ParsedSms | null = null;
    for (const template of TEMPLATES) {
      matched = template(sms);
      if (matched) break;
    }
    if (matched) parsed.push(matched);
    else unparsed.push(sms);
  }

  return { parsed, unparsed };
}
