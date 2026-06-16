/**
 * Nightly ledger invariant checker (T9 / ADR-2).
 *
 * Each check emits one anomaly row per offending data item.
 * Deduplication: if an UNRESOLVED anomaly (resolvedAt IS NULL) with the same
 * detailHash already exists, the insert is skipped.
 *
 * Returned counts = number of NEWLY inserted anomaly rows for that kind PLUS
 * the count of pre-existing unresolved anomalies for that kind (i.e. the total
 * open anomaly count per kind after this run, not just the delta).
 * Rationale: callers / dashboards want to know "how many open issues exist"
 * rather than "how many were new this run". The delta can be inferred if needed.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { computeBalanceAt } from "./derive";
import { add, sub, abs, cmp } from "@/lib/money";

export type AnomalyKind =
  | "orphan_transfer_leg"
  | "transfer_imbalance"
  | "split_mismatch"
  | "anchor_residual"
  | "sign_mismatch"
  | "stale_series"
  | "trade_cash_mismatch"
  | "oversold_holding"
  | "stale_price";

type AnomalyRow = {
  kind: AnomalyKind;
  detail: Record<string, unknown>;
};

// ---- helpers ----------------------------------------------------------------

function detailHash(detail: Record<string, unknown>): string {
  // canonical: sort keys, stable JSON
  const canonical = JSON.stringify(detail, Object.keys(detail).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

async function insertAnomalies(db: Db, rows: AnomalyRow[]): Promise<void> {
  if (rows.length === 0) return;
  for (const row of rows) {
    const hash = detailHash(row.detail);
    const detailJson = JSON.stringify(row.detail);
    // skip if an unresolved anomaly with the same hash already exists
    await db.execute(sql`
      INSERT INTO ledger_anomalies (kind, detail_hash, detail)
      SELECT ${row.kind}, ${hash}, ${detailJson}::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM ledger_anomalies
        WHERE detail_hash = ${hash} AND resolved_at IS NULL
      )
    `);
  }
}

async function countOpen(db: Db, kind: AnomalyKind): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM ledger_anomalies
    WHERE kind = ${kind} AND resolved_at IS NULL
  `);
  return (res as unknown as unknown as { rows: { n: number }[] }).rows[0].n;
}

// ---- checks -----------------------------------------------------------------

/** 1. orphan_transfer_leg: a transfers row where either leg entry is soft-deleted or missing. */
async function checkOrphanTransferLegs(db: Db): Promise<AnomalyRow[]> {
  const res = await db.execute(sql`
    SELECT
      t.id AS transfer_id,
      t.outflow_entry_id,
      t.inflow_entry_id,
      out_e.deleted_at  AS out_deleted,
      in_e.deleted_at   AS in_deleted
    FROM transfers t
    LEFT JOIN entries out_e ON out_e.id = t.outflow_entry_id
    LEFT JOIN entries in_e  ON in_e.id  = t.inflow_entry_id
    WHERE
      out_e.id IS NULL OR out_e.deleted_at IS NOT NULL OR
      in_e.id  IS NULL OR in_e.deleted_at  IS NOT NULL
  `);
  return (
    res as unknown as {
      rows: {
        transfer_id: string;
        outflow_entry_id: string;
        inflow_entry_id: string;
        out_deleted: string | null;
        in_deleted: string | null;
      }[];
    }
  ).rows.map((r) => ({
    kind: "orphan_transfer_leg" as const,
    detail: {
      transferId: r.transfer_id,
      outflowEntryId: r.outflow_entry_id,
      inflowEntryId: r.inflow_entry_id,
      outDeleted: r.out_deleted,
      inDeleted: r.in_deleted,
    },
  }));
}

/** 2. transfer_imbalance: legs where outflow.amount + inflow.amount <> 0, or same-account legs. */
async function checkTransferImbalance(db: Db): Promise<AnomalyRow[]> {
  const res = await db.execute(sql`
    SELECT
      t.id AS transfer_id,
      out_e.id     AS outflow_entry_id,
      in_e.id      AS inflow_entry_id,
      out_e.amount AS outflow_amount,
      in_e.amount  AS inflow_amount,
      out_e.account_id AS outflow_account,
      in_e.account_id  AS inflow_account,
      out_e.currency   AS outflow_currency,
      in_e.currency    AS inflow_currency
    FROM transfers t
    JOIN entries out_e ON out_e.id = t.outflow_entry_id AND out_e.deleted_at IS NULL
    JOIN entries in_e  ON in_e.id  = t.inflow_entry_id  AND in_e.deleted_at IS NULL
    WHERE
      (
        out_e.currency = in_e.currency
        AND (out_e.amount::numeric + in_e.amount::numeric) <> 0
      )
      OR out_e.account_id = in_e.account_id
  `);
  return (
    res as unknown as {
      rows: {
        transfer_id: string;
        outflow_entry_id: string;
        inflow_entry_id: string;
        outflow_amount: string;
        inflow_amount: string;
        outflow_account: string;
        inflow_account: string;
        outflow_currency: string;
        inflow_currency: string;
      }[];
    }
  ).rows.map((r) => ({
    kind: "transfer_imbalance" as const,
    detail: {
      transferId: r.transfer_id,
      outflowEntryId: r.outflow_entry_id,
      inflowEntryId: r.inflow_entry_id,
      outflowAmount: r.outflow_amount,
      inflowAmount: r.inflow_amount,
      outflowAccount: r.outflow_account,
      inflowAccount: r.inflow_account,
    },
  }));
}

/** 3. split_mismatch: splits don't sum to entry.amount, OR parent has category_id set. */
async function checkSplitMismatch(db: Db): Promise<AnomalyRow[]> {
  const res = await db.execute(sql`
    SELECT
      e.id AS entry_id,
      e.amount::numeric AS entry_amount,
      SUM(ts.amount::numeric) AS splits_sum,
      txn.category_id AS txn_category_id
    FROM transaction_splits ts
    JOIN entries      e   ON e.id  = ts.entry_id
    JOIN transactions txn ON txn.entry_id = e.id
    WHERE e.deleted_at IS NULL
    GROUP BY e.id, e.amount, txn.category_id
    HAVING
      SUM(ts.amount::numeric) <> e.amount::numeric
      OR txn.category_id IS NOT NULL
  `);
  return (
    res as unknown as {
      rows: {
        entry_id: string;
        entry_amount: string;
        splits_sum: string | null;
        txn_category_id: string | null;
      }[];
    }
  ).rows.map((r) => ({
    kind: "split_mismatch" as const,
    detail: {
      entryId: r.entry_id,
      entryAmount: r.entry_amount,
      splitsSum: r.splits_sum,
      txnCategoryId: r.txn_category_id,
    },
  }));
}

/**
 * 4. anchor_residual: for each non-deleted valuation entry, check:
 *    residual = valuation.amount − (posted_balance + pending_adjustments)
 *    Flag if |residual| > 0.01.
 *
 * Done entirely in SQL via correlated subqueries — no JS loop.
 */
async function checkAnchorResidual(db: Db): Promise<AnomalyRow[]> {
  const res = await db.execute(sql`
    SELECT
      e.id         AS entry_id,
      e.account_id,
      e.date::text AS anchor_date,
      e.amount::numeric AS anchor_amount,
      (
        a.opening_balance::numeric + COALESCE((
          SELECT SUM(e2.amount::numeric)
          FROM entries e2
          WHERE e2.account_id = e.account_id
            AND e2.entry_type IN ('transaction', 'trade')
            AND e2.status <> 'pending'
            AND e2.deleted_at IS NULL
            AND e2.date <= e.date
        ), 0)
      ) AS posted_balance,
      COALESCE((
        SELECT SUM(e3.amount::numeric)
        FROM entries e3
        JOIN transactions t3 ON t3.entry_id = e3.id
        WHERE e3.account_id = e.account_id
          AND e3.status = 'pending'
          AND e3.deleted_at IS NULL
          AND t3.is_adjustment = true
          AND e3.date <= e.date
      ), 0) AS pending_adj
    FROM entries e
    JOIN valuations v ON v.entry_id = e.id
    JOIN accounts a   ON a.id = e.account_id
    WHERE e.deleted_at IS NULL
  `);

  const rows = (
    res as unknown as {
      rows: {
        entry_id: string;
        account_id: string;
        anchor_date: string;
        anchor_amount: string;
        posted_balance: string;
        pending_adj: string;
      }[];
    }
  ).rows;

  const anomalies: AnomalyRow[] = [];
  for (const r of rows) {
    // money stays in the decimal domain — float64 cannot represent NUMERIC(19,4)
    const derived = add(r.posted_balance, r.pending_adj);
    const residual = sub(r.anchor_amount, derived);
    if (cmp(abs(residual), "0.01") > 0) {
      anomalies.push({
        kind: "anchor_residual",
        detail: {
          entryId: r.entry_id,
          accountId: r.account_id,
          anchorDate: r.anchor_date,
          anchorAmount: r.anchor_amount,
          derivedBalance: derived,
          residual,
        },
      });
    }
  }
  return anomalies;
}

/** 5. sign_mismatch: expense entry with amount > 0, or income entry with amount < 0. */
async function checkSignMismatch(db: Db): Promise<AnomalyRow[]> {
  const res = await db.execute(sql`
    SELECT
      e.id AS entry_id,
      e.account_id,
      e.amount::numeric AS amount,
      c.classification,
      txn.category_id
    FROM entries e
    JOIN transactions txn ON txn.entry_id = e.id
    JOIN categories c     ON c.id = txn.category_id
    WHERE e.deleted_at IS NULL
      AND (
        (c.classification = 'expense' AND e.amount::numeric > 0)
        OR
        (c.classification = 'income'  AND e.amount::numeric < 0)
      )
  `);
  return (
    res as unknown as {
      rows: {
        entry_id: string;
        account_id: string;
        amount: string;
        classification: string;
        category_id: string;
      }[];
    }
  ).rows.map((r) => ({
    kind: "sign_mismatch" as const,
    detail: {
      entryId: r.entry_id,
      accountId: r.account_id,
      amount: r.amount,
      classification: r.classification,
      categoryId: r.category_id,
    },
  }));
}

/**
 * 6. stale_series: for each account that has any balances rows, check the
 *    most recent balances row's balance against the opening+Σentries expression.
 */
async function checkStaleSeries(db: Db): Promise<AnomalyRow[]> {
  const res = await db.execute(sql`
    SELECT
      b.account_id,
      b.date::text AS cached_date,
      b.balance::numeric AS cached_balance,
      (
        a.opening_balance::numeric + COALESCE((
          SELECT SUM(e.amount::numeric)
          FROM entries e
          WHERE e.account_id = b.account_id
            AND e.entry_type IN ('transaction', 'trade')
            AND e.status <> 'pending'
            AND e.deleted_at IS NULL
            AND e.date <= b.date
        ), 0)
      ) AS recomputed
    FROM (
      SELECT DISTINCT ON (account_id)
        account_id, date, balance
      FROM balances
      ORDER BY account_id, date DESC
    ) b
    JOIN accounts a ON a.id = b.account_id
    WHERE
      ABS(
        b.balance::numeric - (
          a.opening_balance::numeric + COALESCE((
            SELECT SUM(e2.amount::numeric)
            FROM entries e2
            WHERE e2.account_id = b.account_id
              AND e2.entry_type IN ('transaction', 'trade')
              AND e2.status <> 'pending'
              AND e2.deleted_at IS NULL
              AND e2.date <= b.date
          ), 0)
        )
      ) > 0.0001
  `);
  return (
    res as unknown as {
      rows: {
        account_id: string;
        cached_date: string;
        cached_balance: string;
        recomputed: string;
      }[];
    }
  ).rows.map((r) => ({
    kind: "stale_series" as const,
    detail: {
      accountId: r.account_id,
      cachedDate: r.cached_date,
      cachedBalance: r.cached_balance,
      recomputed: add(r.recomputed, "0"), // normalize to 4dp in the decimal domain
    },
  }));
}

/**
 * 7. trade_cash_mismatch: a trade entry whose |cash amount| disagrees with
 *    units × price by more than 0.01. One anomaly per offending entry.
 */
async function checkTradeCashMismatch(db: Db): Promise<AnomalyRow[]> {
  const res = await db.execute(sql`
    SELECT
      e.id AS entry_id,
      e.account_id,
      e.amount::numeric AS cash_amount,
      t.units::numeric AS units,
      t.price::numeric AS price,
      (t.units::numeric * t.price::numeric) AS gross
    FROM entries e
    JOIN trades t ON t.entry_id = e.id
    WHERE e.deleted_at IS NULL
      AND e.status <> 'pending'
      AND ABS(ABS(e.amount::numeric) - (t.units::numeric * t.price::numeric)) > 0.01
  `);
  return (
    res as unknown as {
      rows: {
        entry_id: string;
        account_id: string;
        cash_amount: string;
        units: string;
        price: string;
        gross: string;
      }[];
    }
  ).rows.map((r) => ({
    kind: "trade_cash_mismatch" as const,
    detail: {
      entryId: r.entry_id,
      accountId: r.account_id,
      cashAmount: r.cash_amount,
      units: r.units,
      price: r.price,
      gross: r.gross,
    },
  }));
}

/**
 * 8. oversold_holding: net units (Σ buy − Σ sell) for an (account, instrument)
 *    over non-deleted, non-pending trades is negative. One anomaly per pair.
 */
async function checkOversoldHolding(db: Db): Promise<AnomalyRow[]> {
  const res = await db.execute(sql`
    SELECT
      e.account_id,
      t.instrument_id,
      SUM(CASE WHEN t.side = 'buy' THEN t.units::numeric ELSE -t.units::numeric END) AS net_units
    FROM entries e
    JOIN trades t ON t.entry_id = e.id
    WHERE e.deleted_at IS NULL
      AND e.status <> 'pending'
    GROUP BY e.account_id, t.instrument_id
    HAVING SUM(CASE WHEN t.side = 'buy' THEN t.units::numeric ELSE -t.units::numeric END) < 0
  `);
  return (
    res as unknown as {
      rows: {
        account_id: string;
        instrument_id: string;
        net_units: string;
      }[];
    }
  ).rows.map((r) => ({
    kind: "oversold_holding" as const,
    detail: {
      accountId: r.account_id,
      instrumentId: r.instrument_id,
      netUnits: r.net_units,
    },
  }));
}

/**
 * 9. stale_price: an instrument currently held with positive net units
 *    (non-deleted, non-pending) in an investment account, with NO prices row
 *    dated within the last 4 days. One anomaly per offending instrument.
 */
async function checkStalePrice(db: Db): Promise<AnomalyRow[]> {
  const res = await db.execute(sql`
    SELECT
      t.instrument_id,
      SUM(CASE WHEN t.side = 'buy' THEN t.units::numeric ELSE -t.units::numeric END) AS net_units
    FROM entries e
    JOIN trades   t ON t.entry_id = e.id
    JOIN accounts a ON a.id = e.account_id
    WHERE e.deleted_at IS NULL
      AND e.status <> 'pending'
      AND a.kind = 'investment'
    GROUP BY t.instrument_id
    HAVING SUM(CASE WHEN t.side = 'buy' THEN t.units::numeric ELSE -t.units::numeric END) > 0
      AND NOT EXISTS (
        SELECT 1 FROM prices p
        WHERE p.instrument_id = t.instrument_id
          AND p.date >= CURRENT_DATE - INTERVAL '4 days'
      )
  `);
  return (
    res as unknown as {
      rows: {
        instrument_id: string;
        net_units: string;
      }[];
    }
  ).rows.map((r) => ({
    kind: "stale_price" as const,
    detail: {
      instrumentId: r.instrument_id,
      netUnits: r.net_units,
    },
  }));
}

// ---- public API -------------------------------------------------------------

export async function runInvariantChecks(
  db: Db,
): Promise<Record<AnomalyKind, number>> {
  const [
    orphans,
    imbalances,
    splits,
    anchors,
    signs,
    stale,
    tradeCash,
    oversold,
    stalePrice,
  ] = await Promise.all([
    checkOrphanTransferLegs(db),
    checkTransferImbalance(db),
    checkSplitMismatch(db),
    checkAnchorResidual(db),
    checkSignMismatch(db),
    checkStaleSeries(db),
    checkTradeCashMismatch(db),
    checkOversoldHolding(db),
    checkStalePrice(db),
  ]);

  await insertAnomalies(db, [
    ...orphans,
    ...imbalances,
    ...splits,
    ...anchors,
    ...signs,
    ...stale,
    ...tradeCash,
    ...oversold,
    ...stalePrice,
  ]);

  const [c1, c2, c3, c4, c5, c6, c7, c8, c9] = await Promise.all([
    countOpen(db, "orphan_transfer_leg"),
    countOpen(db, "transfer_imbalance"),
    countOpen(db, "split_mismatch"),
    countOpen(db, "anchor_residual"),
    countOpen(db, "sign_mismatch"),
    countOpen(db, "stale_series"),
    countOpen(db, "trade_cash_mismatch"),
    countOpen(db, "oversold_holding"),
    countOpen(db, "stale_price"),
  ]);

  return {
    orphan_transfer_leg: c1,
    transfer_imbalance: c2,
    split_mismatch: c3,
    anchor_residual: c4,
    sign_mismatch: c5,
    stale_series: c6,
    trade_cash_mismatch: c7,
    oversold_holding: c8,
    stale_price: c9,
  };
}
