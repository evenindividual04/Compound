import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { accounts, LIABILITY_KINDS } from "@/db/schema/core";
import { requireHousehold } from "@/lib/current";
import { computeBalanceAt } from "@/lib/ledger/derive";
import { formatINR, abs } from "@/lib/money";
import { todayIST } from "@/lib/dates";
import { Badge } from "@/components/ui/badge";
import { KIND_LABELS } from "@/components/accounts/kind-labels";
import { UpdateBalanceForm } from "@/components/accounts/update-balance-form";
import { AccountActions } from "@/components/accounts/account-actions";

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { householdId } = await requireHousehold();
  const today = todayIST();

  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.householdId, householdId)));

  if (!account) notFound();

  const balance = await computeBalanceAt(db, account.id, today);

  const isLiability = (LIABILITY_KINDS as readonly string[]).includes(account.kind);
  const displayBalance = isLiability
    ? `${formatINR(abs(balance))} owed`
    : formatINR(balance);

  return (
    <div className="min-h-screen bg-background px-4 pt-12 pb-8">
      <header className="mb-6 flex items-center gap-2">
        <Link
          href="/accounts"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          Accounts
        </Link>
      </header>

      {/* Account header */}
      <section className="mb-8">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold">{account.name}</h1>
          {account.excluded && (
            <Badge variant="outline" className="text-xs">
              excluded
            </Badge>
          )}
          {account.status === "closed" && (
            <Badge variant="secondary" className="text-xs">
              closed
            </Badge>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {KIND_LABELS[account.kind]}
        </p>
        <p className="tnum mt-3 text-3xl font-semibold tracking-tight">
          {displayBalance}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">as of today</p>
      </section>

      {/* Update balance */}
      {account.status === "active" && (
        <section className="mb-8">
          <h2 className="mb-4 text-base font-semibold">Update balance</h2>
          <UpdateBalanceForm accountId={account.id} kind={account.kind} today={today} />
        </section>
      )}

      {/* Account actions */}
      <section className="border-t border-border pt-6">
        <AccountActions
          accountId={account.id}
          excluded={account.excluded}
          status={account.status}
        />
      </section>
    </div>
  );
}
