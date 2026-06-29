/**
 * Review Inbox: pending entries and transfers that need user action.
 *
 * Pending transaction entries: imported or system-created entries awaiting
 * review. Transfers: auto-matched pairs awaiting confirm/reject.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { evaluateRule, type RuleInput } from "./rules";
import { annotate } from "./write";
import { afterWrite } from "./derive";
import { recordExampleForEntry } from "@/lib/categorize/examples";
import type { Embedder } from "@/lib/categorize/embed";
// NOTE: the embedder pulls fastembed (native ONNX). It must NEVER be imported at
// module load — that would crash any page on this import chain in serverless
// runtimes (libonnxruntime.so missing). It is resolved lazily, inside best-effort
// try/catch blocks only, so categorization degrades gracefully where the native
// lib is absent. Tests inject a mock embedder via the optional `embed` param.
async function resolveEmbedder(injected?: Embedder): Promise<Embedder> {
  if (injected) return injected;
  return (await import("@/lib/categorize/embed")).embed;
}

// ── Types ──────────────────────────────────────────────────────────────────────

/** Which tier suggested the category: rules engine, learned (T1 k-NN), AI (T2 LLM), or none. */
export type SuggestionSource = "rule" | "learned" | "AI" | null;

export interface PendingEntry {
  entryId: string;
  date: string;
  description: string;
  amount: string;
  source: string;
  accountId: string;
  accountName: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryLocked: boolean;
  merchant: string | null;
  isAdjustment: boolean;
  suggestedCategoryId: string | null;
  /** Source tier that produced the current category suggestion (null when no suggestion). */
  suggestionSource: SuggestionSource;
}

export interface TransferLegSummary {
  entryId: string;
  date: string;
  description: string;
  amount: string;
  accountName: string;
}

export interface PendingTransfer {
  transferId: string;
  outflow: TransferLegSummary;
  inflow: TransferLegSummary;
}

export interface InboxItems {
  pendingEntries: PendingEntry[];
  pendingTransfers: PendingTransfer[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Map an entry_events.source string (from the most recent categoryId event) to a
 * human-readable suggestion tier label.
 *
 *   rule:<id>       → "rule"
 *   categorizer:t1  → "learned"
 *   categorizer:t2  → "AI"
 *   anything else   → null
 */
export function deriveSuggestionSource(eventSource: string | null): SuggestionSource {
  if (!eventSource) return null;
  if (eventSource.startsWith("rule:")) return "rule";
  if (eventSource === "categorizer:t1") return "learned";
  if (eventSource === "categorizer:t2") return "AI";
  return null;
}

/** Log a status change event. */
async function logStatusEvent(
  db: Db,
  entryId: string,
  oldStatus: string,
  newStatus: string,
  source: string,
) {
  await db.insert(schema.entryEvents).values({
    entryId,
    field: "status",
    oldValue: oldStatus,
    newValue: newStatus,
    source,
  });
}

/**
 * Compute suggested category for a transaction entry using the active rules.
 * Returns the first matching rule's set_category action value, or null.
 * Display-only — does not write anything.
 */
async function computeSuggestedCategory(
  db: Db,
  householdId: string,
  entry: { description: string; amount: string },
  merchant: string | null,
): Promise<string | null> {
  const rules = await db
    .select()
    .from(schema.rules)
    .where(and(eq(schema.rules.householdId, householdId), eq(schema.rules.active, true)))
    .orderBy(schema.rules.priority);

  const input: RuleInput = {
    description: entry.description,
    merchant,
    amount: entry.amount,
  };

  for (const rule of rules) {
    const actions = evaluateRule(rule, input);
    for (const action of actions) {
      if (action.type === "set_category") return action.value;
    }
  }
  return null;
}

// ── Core functions ─────────────────────────────────────────────────────────────

/**
 * Count of items needing review:
 * - pending non-deleted transaction entries belonging to this household
 * - pending transfers where either leg belongs to an account in this household
 */
export async function inboxCount(db: Db, householdId: string): Promise<number> {
  const entryCountRes = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt
    FROM entries e
    JOIN accounts a ON a.id = e.account_id
    WHERE e.entry_type = 'transaction'
      AND e.status = 'pending'
      AND e.deleted_at IS NULL
      AND a.household_id = ${householdId}
  `);
  const entryCnt = (entryCountRes as unknown as { rows: { cnt: number }[] }).rows[0].cnt;

  const transferCountRes = await db.execute(sql`
    SELECT COUNT(DISTINCT t.id)::int AS cnt
    FROM transfers t
    WHERE t.status = 'pending'
      AND (
        EXISTS (
          SELECT 1 FROM entries e JOIN accounts a ON a.id = e.account_id
          WHERE e.id = t.outflow_entry_id AND a.household_id = ${householdId}
        )
        OR EXISTS (
          SELECT 1 FROM entries e JOIN accounts a ON a.id = e.account_id
          WHERE e.id = t.inflow_entry_id AND a.household_id = ${householdId}
        )
      )
  `);
  const transferCnt = (transferCountRes as unknown as { rows: { cnt: number }[] }).rows[0].cnt;

  return entryCnt + transferCnt;
}

/**
 * Full inbox: pending entries + pending transfers, both with account/category info.
 */
export async function inboxItems(db: Db, householdId: string): Promise<InboxItems> {
  // ── Pending entries ────────────────────────────────────────────────────────
  const rawEntries = await db.execute(sql`
    SELECT
      e.id          AS entry_id,
      e.date        AS date,
      e.description AS description,
      e.amount      AS amount,
      e.source      AS source,
      e.account_id  AS account_id,
      a.name        AS account_name,
      t.category_id AS category_id,
      c.name        AS category_name,
      t.category_locked AS category_locked,
      t.merchant    AS merchant,
      t.is_adjustment AS is_adjustment,
      (
        SELECT ev.source
        FROM entry_events ev
        WHERE ev.entry_id = e.id AND ev.field = 'categoryId'
        ORDER BY ev.at DESC
        LIMIT 1
      ) AS latest_category_source
    FROM entries e
    JOIN accounts a ON a.id = e.account_id
    JOIN transactions t ON t.entry_id = e.id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE e.entry_type = 'transaction'
      AND e.status = 'pending'
      AND e.deleted_at IS NULL
      AND a.household_id = ${householdId}
    ORDER BY e.date DESC, e.created_at DESC
  `);

  type RawEntry = {
    entry_id: string;
    date: string;
    description: string;
    amount: string;
    source: string;
    account_id: string;
    account_name: string;
    category_id: string | null;
    category_name: string | null;
    category_locked: boolean;
    merchant: string | null;
    is_adjustment: boolean;
    latest_category_source: string | null;
  };

  const rows = (rawEntries as unknown as { rows: RawEntry[] }).rows;

  // Compute suggestions for unlocked entries without a category.
  const pendingEntries: PendingEntry[] = await Promise.all(
    rows.map(async (r) => {
      let suggestedCategoryId: string | null = null;
      if (!r.category_id && !r.category_locked) {
        suggestedCategoryId = await computeSuggestedCategory(
          db,
          householdId,
          { description: r.description, amount: r.amount },
          r.merchant,
        );
      }
      // suggestionSource: meaningful when the category is not user-locked (i.e., it came from a
      // categorizer or rule tier and could still be corrected). Derive from the most recent
      // categoryId event. For rule-engine suggestions (category_id=null, suggestedCategoryId set),
      // the source is also captured if annotate was called. When category_id IS set but unlocked,
      // we still surface the source so the UI can show "learned"/"AI"/"rule" next to the category.
      const suggestionSource = !r.category_locked
        ? deriveSuggestionSource(r.latest_category_source)
        : null;
      return {
        entryId: r.entry_id,
        date: r.date,
        description: r.description,
        amount: r.amount,
        source: r.source,
        accountId: r.account_id,
        accountName: r.account_name,
        categoryId: r.category_id,
        categoryName: r.category_name,
        categoryLocked: r.category_locked,
        merchant: r.merchant,
        isAdjustment: r.is_adjustment,
        suggestedCategoryId,
        suggestionSource,
      };
    }),
  );

  // ── Pending transfers ──────────────────────────────────────────────────────
  const rawTransfers = await db.execute(sql`
    SELECT
      t.id                AS transfer_id,
      oe.id               AS out_entry_id,
      oe.date             AS out_date,
      oe.description      AS out_description,
      oe.amount           AS out_amount,
      oa.name             AS out_account_name,
      ie.id               AS in_entry_id,
      ie.date             AS in_date,
      ie.description      AS in_description,
      ie.amount           AS in_amount,
      ia.name             AS in_account_name
    FROM transfers t
    JOIN entries oe ON oe.id = t.outflow_entry_id
    JOIN accounts oa ON oa.id = oe.account_id
    JOIN entries ie ON ie.id = t.inflow_entry_id
    JOIN accounts ia ON ia.id = ie.account_id
    WHERE t.status = 'pending'
      AND (oa.household_id = ${householdId} OR ia.household_id = ${householdId})
    ORDER BY oe.date DESC
  `);

  type RawTransfer = {
    transfer_id: string;
    out_entry_id: string;
    out_date: string;
    out_description: string;
    out_amount: string;
    out_account_name: string;
    in_entry_id: string;
    in_date: string;
    in_description: string;
    in_amount: string;
    in_account_name: string;
  };

  const pendingTransfers: PendingTransfer[] = (
    rawTransfers as unknown as { rows: RawTransfer[] }
  ).rows.map((r) => ({
    transferId: r.transfer_id,
    outflow: {
      entryId: r.out_entry_id,
      date: r.out_date,
      description: r.out_description,
      amount: r.out_amount,
      accountName: r.out_account_name,
    },
    inflow: {
      entryId: r.in_entry_id,
      date: r.in_date,
      description: r.in_description,
      amount: r.in_amount,
      accountName: r.in_account_name,
    },
  }));

  return { pendingEntries, pendingTransfers };
}

// ── Write helpers ──────────────────────────────────────────────────────────────

/** Flip entry status pending → posted and append an entry_events row. */
export async function postEntry(db: Db, entryId: string, source: string): Promise<void> {
  await db
    .update(schema.entries)
    .set({ status: "posted" })
    .where(and(eq(schema.entries.id, entryId), eq(schema.entries.status, "pending")));
  await logStatusEvent(db, entryId, "pending", "posted", source);
}

/**
 * Accept a pending entry:
 * 1. If categoryId provided, annotate (locks category, source 'user')
 * 2. postEntry
 * 3. afterWrite (rebuild balances + rollups)
 * 4. recordExampleForEntry (best-effort; never blocks the accept)
 */
export async function acceptEntry(
  db: Db,
  entryId: string,
  source: string,
  categoryId?: string,
  embed?: Embedder,
): Promise<void> {
  // Fetch entry for afterWrite args.
  const [entry] = await db
    .select({ accountId: schema.entries.accountId, date: schema.entries.date })
    .from(schema.entries)
    .where(and(eq(schema.entries.id, entryId), isNull(schema.entries.deletedAt)));
  if (!entry) throw new Error("entry not found");

  const [acct] = await db
    .select({ householdId: schema.accounts.householdId })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, entry.accountId));
  if (!acct) throw new Error("account not found");

  if (categoryId) {
    await annotate(db, entryId, { categoryId }, "user");
  }
  await postEntry(db, entryId, source);
  await afterWrite(db, { accountId: entry.accountId, householdId: acct.householdId, date: entry.date });

  try {
    await recordExampleForEntry(db, entryId, categoryId ? "correct" : "accept", await resolveEmbedder(embed));
  } catch {
    // Best-effort: training write failure must never block the accept.
  }
}

/**
 * Accept multiple entries in bulk (no category change — uses current categories).
 */
export async function acceptAll(
  db: Db,
  entryIds: string[],
  source: string,
  embed?: Embedder,
): Promise<void> {
  if (entryIds.length === 0) return;

  // Fetch all entries at once.
  const entries = await db
    .select({
      id: schema.entries.id,
      accountId: schema.entries.accountId,
      date: schema.entries.date,
    })
    .from(schema.entries)
    .where(
      and(
        inArray(schema.entries.id, entryIds),
        eq(schema.entries.status, "pending"),
        isNull(schema.entries.deletedAt),
      ),
    );

  if (entries.length === 0) return;

  // Bulk update status.
  await db
    .update(schema.entries)
    .set({ status: "posted" })
    .where(inArray(schema.entries.id, entryIds));

  // Log events and trigger afterWrite per unique account.
  const seen = new Set<string>();
  for (const e of entries) {
    await logStatusEvent(db, e.id, "pending", "posted", source);
    if (!seen.has(e.accountId)) {
      seen.add(e.accountId);
      const [acct] = await db
        .select({ householdId: schema.accounts.householdId })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, e.accountId));
      if (acct) {
        await afterWrite(db, { accountId: e.accountId, householdId: acct.householdId, date: e.date });
      }
    }
    try {
      await recordExampleForEntry(db, e.id, "accept", await resolveEmbedder(embed));
    } catch {
      // Best-effort: training write failure (incl. embedder load) must never block the accept.
    }
  }
}
