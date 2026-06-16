/**
 * Holdings are pure recomputation from trade entries, in entry order — never stored
 * as mutable truth (mirrors balances; spec §4.3.5). Units/price at 6dp, cash/cost at 4dp.
 * Average-cost method; partial sells leave avgCost unchanged and realize
 * P&L = unitsSold × (price − avgCost).
 */
import { sql } from "drizzle-orm";
import Decimal from "decimal.js-light";
import type { Db } from "@/db";

Decimal.set({ precision: 38 });

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export interface Holding {
  accountId: string;
  instrumentId: string;
  units: string;
  avgCost: string;
  realizedPnl: string;
}

interface TradeRow {
  account_id: string;
  instrument_id: string;
  side: "buy" | "sell";
  units: string;
  price: string;
}

export async function computeHoldings(ex: Executor, householdId: string, asOf: string): Promise<Holding[]> {
  const res = await ex.execute(sql`
    SELECT e.account_id, t.instrument_id, t.side, t.units::text AS units, t.price::text AS price
    FROM entries e
    JOIN trades t ON t.entry_id = e.id
    JOIN accounts a ON a.id = e.account_id
    WHERE a.household_id = ${householdId}
      AND e.status <> 'pending'
      AND e.deleted_at IS NULL
      AND e.date <= ${asOf}
    ORDER BY e.date, e.created_at
  `);
  const rows = (res as unknown as { rows: TradeRow[] }).rows;

  const acc = new Map<string, { accountId: string; instrumentId: string; units: Decimal; cost: Decimal; realized: Decimal }>();
  for (const r of rows) {
    const key = `${r.account_id}:${r.instrument_id}`;
    let h = acc.get(key);
    if (!h) {
      h = { accountId: r.account_id, instrumentId: r.instrument_id, units: new Decimal(0), cost: new Decimal(0), realized: new Decimal(0) };
      acc.set(key, h);
    }
    const u = new Decimal(r.units);
    const p = new Decimal(r.price);
    if (r.side === "buy") {
      h.cost = h.cost.plus(u.times(p));
      h.units = h.units.plus(u);
    } else {
      const avg = h.units.isZero() ? new Decimal(0) : h.cost.div(h.units);
      h.realized = h.realized.plus(u.times(p.minus(avg)));
      h.cost = h.cost.minus(u.times(avg));
      h.units = h.units.minus(u);
    }
  }

  return [...acc.values()].map((h) => {
    const avgCost = h.units.isZero() ? new Decimal(0) : h.cost.div(h.units);
    return {
      accountId: h.accountId,
      instrumentId: h.instrumentId,
      units: h.units.toFixed(6),
      avgCost: avgCost.toFixed(6),
      realizedPnl: h.realized.toFixed(4),
    };
  });
}
