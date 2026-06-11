import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts, LIABILITY_KINDS } from "@/db/schema/core";
import { requireHousehold } from "@/lib/current";
import { computeBalanceAt, netWorth } from "@/lib/ledger/derive";
import { formatINR, formatINRCompact, abs } from "@/lib/money";
import { todayIST } from "@/lib/dates";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";

export default async function AccountsPage() {
  const { householdId } = await requireHousehold();
  const today = todayIST();

  const [nw, allAccounts] = await Promise.all([
    netWorth(db, householdId, today),
    db.select().from(accounts).where(eq(accounts.householdId, householdId)),
  ]);

  // Compute balance for every account in parallel
  const withBalances = await Promise.all(
    allAccounts.map(async (acct) => ({
      ...acct,
      balance: await computeBalanceAt(db, acct.id, today),
    })),
  );

  const isLiability = (kind: string) =>
    (LIABILITY_KINDS as readonly string[]).includes(kind);

  const assets = withBalances.filter((a) => !isLiability(a.kind));
  const liabilities = withBalances.filter((a) => isLiability(a.kind));

  return (
    <div className="min-h-screen bg-background px-4 pt-12 pb-8">
      {/* Net worth headline */}
      <section className="flex flex-col items-center gap-1 py-8">
        <p className="text-sm text-muted-foreground">Net worth</p>
        <p className="tnum text-5xl font-semibold tracking-tight text-foreground">
          {formatINRCompact(nw)}
        </p>
        <p className="tnum text-sm text-muted-foreground">{formatINR(nw)}</p>
      </section>

      {/* Add account */}
      <div className="mb-6 flex justify-end">
        <Link href="/accounts/new" className={buttonVariants({ size: "sm" })}>
          + Add account
        </Link>
      </div>

      {/* Assets */}
      {assets.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Assets
          </h2>
          <ul className="space-y-2">
            {assets.map((acct) => (
              <AccountRow key={acct.id} acct={acct} isLiabilityKind={false} />
            ))}
          </ul>
        </section>
      )}

      {/* Liabilities */}
      {liabilities.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Liabilities
          </h2>
          <ul className="space-y-2">
            {liabilities.map((acct) => (
              <AccountRow key={acct.id} acct={acct} isLiabilityKind={true} />
            ))}
          </ul>
        </section>
      )}

      {allAccounts.length === 0 && (
        <p className="mt-16 text-center text-sm text-muted-foreground">
          No accounts yet.{" "}
          <Link href="/accounts/new" className="text-primary underline">
            Add your first account
          </Link>
        </p>
      )}
    </div>
  );
}

type Account = {
  id: string;
  name: string;
  kind: string;
  status: string;
  excluded: boolean;
  balance: string;
};

function AccountRow({
  acct,
  isLiabilityKind,
}: {
  acct: Account;
  isLiabilityKind: boolean;
}) {
  const displayBalance = isLiabilityKind
    ? `${formatINR(abs(acct.balance))} owed`
    : formatINR(acct.balance);

  return (
    <li>
      <Link
        href={`/accounts/${acct.id}`}
        className={`flex items-center justify-between rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10 transition-colors hover:bg-card/80 ${acct.excluded ? "opacity-50" : ""}`}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{acct.name}</span>
          {acct.excluded && (
            <Badge variant="outline" className="text-[10px]">
              excluded
            </Badge>
          )}
          {acct.status === "closed" && (
            <Badge variant="secondary" className="text-[10px]">
              closed
            </Badge>
          )}
        </div>
        <span className="tnum text-sm text-muted-foreground">{displayBalance}</span>
      </Link>
    </li>
  );
}
