import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireHousehold } from "@/lib/current";
import { todayIST } from "@/lib/dates";
import { computeHoldings } from "@/lib/invest/holdings";
import { xirr, type CashFlow } from "@/lib/invest/xirr";
import { mul, sub, neg, cmp } from "@/lib/money";
import { HoldingsTable, type HoldingRow } from "@/components/invest/holdings-table";

const STALE_DAYS = 4;

interface InstrumentMeta {
  id: string;
  name: string;
  kind: string;
  symbol: string | null;
}

interface TradeLeg {
  date: string;
  side: "buy" | "sell";
  units: string;
  price: string;
}

interface PriceMeta {
  nav: string;
  date: string;
}

/** Latest price plus its as-of date (for staleness display). Null if no price row. */
async function latestPriceWithDate(
  instrumentId: string,
  asOf: string,
): Promise<PriceMeta | null> {
  const res = await db.execute(sql`
    SELECT nav::text AS nav, date::text AS date FROM prices
    WHERE instrument_id = ${instrumentId} AND date <= ${asOf}
    ORDER BY date DESC LIMIT 1
  `);
  const row = (res as unknown as { rows: PriceMeta[] }).rows[0];
  return row ?? null;
}

/** Trade legs for one instrument in this household (excludes pending + deleted). */
async function tradeLegs(instrumentId: string, householdId: string): Promise<TradeLeg[]> {
  const res = await db.execute(sql`
    SELECT e.date::text AS date, t.side, t.units::text AS units, t.price::text AS price
    FROM entries e
    JOIN trades t ON t.entry_id = e.id
    JOIN accounts a ON a.id = e.account_id
    WHERE a.household_id = ${householdId}
      AND t.instrument_id = ${instrumentId}
      AND e.status <> 'pending'
      AND e.deleted_at IS NULL
    ORDER BY e.date, e.created_at
  `);
  return (res as unknown as { rows: TradeLeg[] }).rows;
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = new Date(`${fromYmd}T00:00:00Z`).getTime();
  const b = new Date(`${toYmd}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

export default async function InvestPage() {
  const { householdId } = await requireHousehold();
  const today = todayIST();

  const holdings = (await computeHoldings(db, householdId, today)).filter(
    (h) => cmp(h.units, "0") > 0,
  );

  // Load instrument metadata for the held instruments
  const instrumentIds = [...new Set(holdings.map((h) => h.instrumentId))];
  const instrumentById = new Map<string, InstrumentMeta>();
  if (instrumentIds.length > 0) {
    const metaRes = await db.execute(sql`
      SELECT id::text AS id, name, kind::text AS kind, symbol
      FROM instruments
      WHERE household_id = ${householdId}
        AND id IN (${sql.join(
          instrumentIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
    `);
    for (const m of (metaRes as unknown as { rows: InstrumentMeta[] }).rows) {
      instrumentById.set(m.id, m);
    }
  }

  const rows: HoldingRow[] = await Promise.all(
    holdings.map(async (h) => {
      const meta = instrumentById.get(h.instrumentId);
      const priceMeta = await latestPriceWithDate(h.instrumentId, today);
      const currentPrice = priceMeta?.nav ?? null;
      const priceDate = priceMeta?.date ?? null;

      const cost = mul(h.units, h.avgCost); // total cost basis
      // Mark-to-market value; fall back to cost basis when no price is known.
      const currentValue = currentPrice ? mul(h.units, currentPrice) : cost;
      const unrealizedPnl = currentPrice ? sub(currentValue, cost) : "0.0000";

      const stale =
        currentPrice === null ||
        priceDate === null ||
        daysBetween(priceDate, today) > STALE_DAYS;

      // XIRR cashflows: each buy is money out (−units×price), each sell is money in
      // (+units×price), plus a terminal mark-to-market inflow at today.
      const legs = await tradeLegs(h.instrumentId, householdId);
      const cashflows: CashFlow[] = legs.map((leg) => {
        const gross = mul(leg.units, leg.price);
        return {
          date: leg.date,
          amount: leg.side === "buy" ? neg(gross) : gross,
        };
      });
      cashflows.push({ date: today, amount: currentValue });
      const rate = xirr(cashflows);

      return {
        instrumentId: h.instrumentId,
        instrumentName: meta?.name ?? meta?.symbol ?? "Unknown instrument",
        kind: meta?.kind ?? "—",
        units: h.units,
        avgCost: h.avgCost,
        currentPrice,
        priceDate,
        currentValue,
        unrealizedPnl,
        xirr: rate,
        stale,
      };
    }),
  );

  return (
    <div className="min-h-screen bg-paper px-4 pt-12 pb-8">
      <HoldingsTable rows={rows} />
    </div>
  );
}
