/**
 * Price persistence + reads. Daily NAV/quote time series, unique on (instrument, date).
 * Equity quotes come from an injected fetcher (the concrete source — fragile, rate-limited —
 * is chosen in the cron); on failure we write no row and valuation falls back to the
 * last known price (spec §5/§6 "fall back visibly, never a wrong number").
 */
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export interface PriceRow {
  instrumentId: string;
  date: string;
  nav: string;
}

export async function upsertPrices(ex: Executor, rows: PriceRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    await ex
      .insert(schema.prices)
      .values(batch)
      .onConflictDoUpdate({ target: [schema.prices.instrumentId, schema.prices.date], set: { nav: sql`excluded.nav` } });
  }
}

export async function latestPriceAt(ex: Executor, instrumentId: string, date: string): Promise<string | null> {
  const res = await ex.execute(sql`
    SELECT nav::text AS nav FROM prices
    WHERE instrument_id = ${instrumentId} AND date <= ${date}
    ORDER BY date DESC LIMIT 1
  `);
  const row = (res as unknown as { rows: { nav: string }[] }).rows[0];
  return row ? row.nav : null;
}

/** Equity quote fetcher contract. Implementations live behind the cron; returns null on miss. */
export type EquityQuoteFetcher = (symbol: string) => Promise<string | null>;
