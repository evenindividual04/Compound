/**
 * Net-worth breakdown series for the dashboard chart.
 *
 * Produces MONTHLY points over the last 12 months (≈13 points): each prior
 * month-end plus today for the latest point. Each point splits net worth into
 * four asset-class buckets so the chart can stack them.
 *
 * Correctness (spec §4.3): investment accounts are valued by MARKET VALUE via
 * `holdingValueAt`, never by summing their trade cash-flows from the balances
 * table. Non-investment accounts use their cash balance read from the `balances`
 * materialized table (LOCF: latest row ≤ the point date).
 *
 * Note: this is NOT a provable identity with the scalar `netWorth()` in
 * derive.ts — that function derives non-investment balances live from the
 * `entries` table, whereas this series reads the materialized `balances` cache.
 * The two agree only when that cache is fresh (which `afterWrite` and the
 * nightly invariant cron maintain); they can diverge transiently if the cache
 * is stale. Investment valuation (holdingValueAt) is identical in both.
 *
 * MONEY BOUNDARY: money is NUMERIC strings everywhere in the ledger. This module
 * is the documented RSC/chart boundary — the ONLY place we convert to `number`,
 * right before handing rows to the Recharts client island (same exception as
 * src/components/dashboard/chart-data.ts). Conversion happens once, at the end.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { add } from "@/lib/money";
import { holdingValueAt } from "@/lib/ledger/derive";

export interface NetWorthBreakdownPoint {
  month: string; // 'YYYY-MM' label for the point
  cash: number; // bank / cash / wallet
  investments: number; // investment-kind accounts at market value
  otherAssets: number; // epf/ppf/fd/property/gold/crypto/receivable/other_asset
  liabilities: number; // credit_card/loan/other_liability — negative (or 0)
  net: number; // cash + investments + otherAssets + liabilities
}

// Bucketing of account kinds. 'investment' is handled separately (market value).
const CASH_KINDS = ["bank", "cash", "wallet"] as const;
const LIABILITY_KINDS = ["credit_card", "loan", "other_liability"] as const;
const OTHER_ASSET_KINDS = [
  "epf",
  "ppf",
  "fd",
  "property",
  "gold",
  "crypto",
  "receivable",
  "other_asset",
] as const;

interface NonInvestRow {
  d: string; // 'YYYY-MM-DD' point date
  cash: string;
  liabilities: string;
  other_assets: string;
}

/**
 * Net-worth breakdown over the last 12 months, oldest→newest.
 *
 * @returns rows with money already converted to numbers (chart boundary).
 */
export async function netWorthBreakdownSeries(
  db: Db,
  householdId: string,
): Promise<NetWorthBreakdownPoint[]> {
  // Point dates: each prior month-end for the last 12 months, then today.
  // Built once in SQL and reused; the same CTE is inlined into the bucket query
  // below (drizzle can't bind a JS array as a Postgres date[] param cleanly).
  const pointDatesSql = sql`
    SELECT (date_trunc('month', CURRENT_DATE) - ((gs.n - 1) || ' months')::interval - INTERVAL '1 day')::date AS d
    FROM generate_series(12, 1, -1) AS gs(n)
    UNION ALL
    SELECT CURRENT_DATE AS d
  `;
  const dateRes = await db.execute(sql`SELECT d::text AS d FROM (${pointDatesSql}) pd ORDER BY d`);
  const pointDates = (dateRes as unknown as { rows: { d: string }[] }).rows.map((r) => r.d);

  // Non-investment buckets per point date: cash balance LOCF (latest balance
  // row ≤ the point date) grouped into the three non-investment buckets.
  const nonInvestRes = await db.execute(sql`
    WITH point_dates AS (
      ${pointDatesSql}
    ),
    accts AS (
      SELECT id, kind FROM accounts
      WHERE household_id = ${householdId}::uuid
        AND status = 'active'
        AND excluded = false
        AND kind <> 'investment'
    ),
    balances_at AS (
      SELECT
        pd.d,
        a.kind,
        (
          SELECT b.balance::numeric
          FROM balances b
          WHERE b.account_id = a.id
            AND b.date <= pd.d
          ORDER BY b.date DESC
          LIMIT 1
        ) AS balance
      FROM point_dates pd
      CROSS JOIN accts a
    )
    SELECT
      ba.d::text AS d,
      COALESCE(SUM(ba.balance) FILTER (WHERE ba.kind IN ('bank','cash','wallet')), 0)::numeric(19,4)::text AS cash,
      COALESCE(SUM(ba.balance) FILTER (WHERE ba.kind IN ('credit_card','loan','other_liability')), 0)::numeric(19,4)::text AS liabilities,
      COALESCE(SUM(ba.balance) FILTER (WHERE ba.kind IN ('epf','ppf','fd','property','gold','crypto','receivable','other_asset')), 0)::numeric(19,4)::text AS other_assets
    FROM balances_at ba
    GROUP BY ba.d
    ORDER BY ba.d
  `);
  const nonInvestByDate = new Map<string, NonInvestRow>(
    (nonInvestRes as unknown as { rows: NonInvestRow[] }).rows.map((r) => [r.d, r]),
  );

  // Investment-kind accounts — valued at market value per point date.
  const investRes = await db.execute(sql`
    SELECT id FROM accounts
    WHERE household_id = ${householdId}::uuid
      AND status = 'active'
      AND excluded = false
      AND kind = 'investment'
  `);
  const investAccountIds = (investRes as unknown as { rows: { id: string }[] }).rows.map((r) => r.id);

  // Value every (point date × investment account) pair concurrently — one round
  // trip of latency instead of date×account sequential awaits. Same valuation
  // semantics (holdingValueAt per account per point date), then reduce into a
  // per-date market-value sum (string math).
  const investPairs = pointDates.flatMap((date) =>
    investAccountIds.map((accountId) => ({ date, accountId })),
  );
  const investValues = await Promise.all(
    investPairs.map((p) => holdingValueAt(db, p.accountId, p.date)),
  );
  const investByDate = new Map<string, string>(pointDates.map((d) => [d, "0.0000"]));
  investPairs.forEach((p, i) => {
    investByDate.set(p.date, add(investByDate.get(p.date) ?? "0.0000", investValues[i]));
  });

  const points: NetWorthBreakdownPoint[] = [];
  for (const date of pointDates) {
    const nonInvest = nonInvestByDate.get(date);
    const cashStr = nonInvest?.cash ?? "0.0000";
    const liabilitiesStr = nonInvest?.liabilities ?? "0.0000";
    const otherAssetsStr = nonInvest?.other_assets ?? "0.0000";

    const investStr = investByDate.get(date) ?? "0.0000";

    const netStr = add(add(add(cashStr, investStr), otherAssetsStr), liabilitiesStr);

    // --- MONEY BOUNDARY: convert NUMERIC strings → numbers for the chart only ---
    points.push({
      month: date.slice(0, 7),
      cash: Number(cashStr),
      investments: Number(investStr),
      otherAssets: Number(otherAssetsStr),
      liabilities: Number(liabilitiesStr),
      net: Number(netStr),
    });
  }

  return points;
}

// Re-export bucket definitions for documentation/testing clarity (not required
// by callers, but keeps the kind→bucket mapping in one place).
export const NETWORTH_BUCKETS = {
  cash: CASH_KINDS,
  liabilities: LIABILITY_KINDS,
  otherAssets: OTHER_ASSET_KINDS,
} as const;
