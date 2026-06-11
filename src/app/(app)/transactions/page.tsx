import { Suspense } from "react";
import Link from "next/link";
import { and, desc, eq, exists, isNull, sql } from "drizzle-orm";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { requireHousehold } from "@/lib/current";
import { todayIST } from "@/lib/dates";
import type { TxnRow } from "@/components/txn-row";
import type { CategoryOption } from "@/components/category-picker";
import { TxnListClient } from "./txn-list-client";

const PAGE_SIZE = 200;

function parseMonth(raw: string | undefined): string {
  if (raw && /^\d{4}-\d{2}$/.test(raw)) return raw;
  return todayIST().slice(0, 7);
}

function prevMonth(m: string) {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(y, mo - 2, 1); // mo-1 = 0-based current, -1 = prev
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function nextMonth(m: string) {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(y, mo, 1); // mo-1 = 0-based current, +1 = next
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(m: string) {
  const [y, mo] = m.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(
    new Date(y, mo - 1, 1),
  );
}

interface PageProps {
  searchParams: Promise<{ month?: string; page?: string }>;
}

export default async function TransactionsPage({ searchParams }: PageProps) {
  const { householdId } = await requireHousehold();
  const params = await searchParams;
  const month = parseMonth(params.month);
  const page = Math.max(1, parseInt(params.page ?? "1", 10));
  const offset = (page - 1) * PAGE_SIZE;

  const monthStart = `${month}-01`;
  // last day of month: first of next month minus one day
  const [y, mo] = month.split("-").map(Number);
  const monthEnd = new Date(y, mo, 0).toISOString().slice(0, 10); // last day

  // Fetch transactions with category name, account name, transfer leg flag
  const isTransferLegExpr = exists(
    db
      .select({ one: sql<number>`1` })
      .from(schema.transfers)
      .where(
        sql`${schema.transfers.outflowEntryId} = ${schema.entries.id} OR ${schema.transfers.inflowEntryId} = ${schema.entries.id}`,
      ),
  );

  const rows = await db
    .select({
      entryId: schema.entries.id,
      date: schema.entries.date,
      description: schema.entries.description,
      merchant: schema.transactions.merchant,
      categoryId: schema.transactions.categoryId,
      categoryName: schema.categories.name,
      accountName: schema.accounts.name,
      amount: schema.entries.amount,
      status: schema.entries.status,
      isTransferLeg: isTransferLegExpr,
    })
    .from(schema.entries)
    .innerJoin(schema.transactions, eq(schema.transactions.entryId, schema.entries.id))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.entries.accountId))
    .leftJoin(schema.categories, eq(schema.categories.id, schema.transactions.categoryId))
    .where(
      and(
        eq(schema.accounts.householdId, householdId),
        isNull(schema.entries.deletedAt),
        sql`${schema.entries.date} >= ${monthStart}`,
        sql`${schema.entries.date} <= ${monthEnd}`,
      ),
    )
    .orderBy(desc(schema.entries.date), desc(schema.entries.createdAt))
    .limit(PAGE_SIZE + 1) // fetch one extra to detect more pages
    .offset(offset);

  const hasMore = rows.length > PAGE_SIZE;
  const visibleRows = rows.slice(0, PAGE_SIZE);

  // Cast to TxnRow (status is narrowed by DB enum, isTransferLeg is boolean from EXISTS)
  const txnRows: TxnRow[] = visibleRows.map((r) => ({
    entryId: r.entryId,
    date: r.date,
    description: r.description,
    merchant: r.merchant ?? null,
    categoryId: r.categoryId ?? null,
    categoryName: r.categoryName ?? null,
    accountName: r.accountName,
    amount: r.amount,
    status: r.status as TxnRow["status"],
    isTransferLeg: Boolean(r.isTransferLeg),
  }));

  // Fetch all leaf categories for the household (no parentId filter = include all)
  const catRows = await db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      parentId: schema.categories.parentId,
      classification: schema.categories.classification,
    })
    .from(schema.categories)
    .where(eq(schema.categories.householdId, householdId));

  // Build parentName lookup
  const catById = new Map(catRows.map((c) => [c.id, c]));
  const categories: CategoryOption[] = catRows.map((c) => ({
    id: c.id,
    name: c.name,
    parentName: c.parentId ? (catById.get(c.parentId)?.name ?? null) : null,
    classification: c.classification as CategoryOption["classification"],
  }));

  const prev = prevMonth(month);
  const next = nextMonth(month);
  const current = todayIST().slice(0, 7);
  const isCurrentMonth = month === current;

  return (
    <div className="min-h-screen bg-background">
      {/* Month pager header */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
        <Link
          href={`/transactions?month=${prev}`}
          className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted"
          aria-label="Previous month"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <span className="text-sm font-semibold">{monthLabel(month)}</span>
        <Link
          href={`/transactions?month=${next}`}
          className={`flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted ${isCurrentMonth ? "pointer-events-none opacity-30" : ""}`}
          aria-label="Next month"
          aria-disabled={isCurrentMonth}
        >
          <ChevronRight className="h-5 w-5" />
        </Link>
      </header>

      {/* Transaction list */}
      {txnRows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
          <p className="text-sm">No transactions in {monthLabel(month)}</p>
        </div>
      ) : (
        <Suspense>
          <TxnListClient
            rows={txnRows}
            categories={categories}
            month={month}
          />
        </Suspense>
      )}

      {/* Load more */}
      {hasMore && (
        <div className="flex justify-center py-4">
          <Link
            href={`/transactions?month=${month}&page=${page + 1}`}
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            Load more
          </Link>
        </div>
      )}
    </div>
  );
}
