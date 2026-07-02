import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { eq, and, isNull, desc } from "drizzle-orm";
import { formatDistanceToNow } from "date-fns";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { requireHousehold } from "@/lib/current";
import { getBridgeStatus } from "@/lib/ledger/bridge-status";
import { UnmappedRow } from "@/components/setup/unmapped-row";

export default async function SetupPage() {
  const { householdId } = await requireHousehold();

  const [{ status, lastSeenAt }, accounts, unmapped, unparsed] = await Promise.all([
    getBridgeStatus(db, householdId),
    db
      .select({ id: schema.accounts.id, name: schema.accounts.name, kind: schema.accounts.kind, metadata: schema.accounts.metadata })
      .from(schema.accounts)
      .where(eq(schema.accounts.householdId, householdId)),
    db
      .select()
      .from(schema.ledgerAnomalies)
      .where(and(eq(schema.ledgerAnomalies.kind, "sms_unmapped"), isNull(schema.ledgerAnomalies.resolvedAt)))
      .orderBy(desc(schema.ledgerAnomalies.detectedAt)),
    db
      .select()
      .from(schema.ledgerAnomalies)
      .where(and(eq(schema.ledgerAnomalies.kind, "sms_unparsed"), isNull(schema.ledgerAnomalies.resolvedAt)))
      .orderBy(desc(schema.ledgerAnomalies.detectedAt)),
  ]);

  const statusLabel =
    status === "never"
      ? "Not connected yet"
      : status === "stale"
        ? `Hasn't checked in for ${formatDistanceToNow(new Date(lastSeenAt!))}`
        : `Connected · last check-in ${formatDistanceToNow(new Date(lastSeenAt!), { addSuffix: true })}`;

  const accountOptions = accounts.map((a) => ({ id: a.id, name: a.name }));

  return (
    <div className="min-h-screen bg-paper px-4 pt-12 pb-8">
      <header className="mb-6 flex items-center gap-2">
        <Link href="/browse" className="flex items-center gap-1 text-sm text-soft hover:text-ink">
          <ChevronLeft className="h-4 w-4" />
          Browse
        </Link>
      </header>

      <h1 className="font-display text-3xl font-bold text-ink mb-6">Setup</h1>

      {/* SMS sync status */}
      <section className="mb-6">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-soft">
          SMS sync
        </p>
        <div className="rounded-2xl border border-hairline bg-surface p-4">
          <p className="text-sm text-ink mb-2">{statusLabel}</p>
          {status !== "ok" && (
            <p className="text-xs text-soft">
              This lets the sync tool read your Messages app, where your bank texts land.
            </p>
          )}
        </div>
      </section>

      {/* Accounts + SMS keys */}
      <section className="mb-6">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-soft">
          Your accounts
        </p>
        <div className="rounded-2xl border border-hairline bg-surface divide-y divide-hairline">
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-ink">{a.name}</span>
              <span className="text-xs text-soft tnum">{a.metadata?.smsKey ?? "—"}</span>
            </div>
          ))}
          {accounts.length === 0 && (
            <p className="px-4 py-3 text-sm text-soft">No accounts yet.</p>
          )}
        </div>
      </section>

      {/* Needs an account */}
      {unmapped.length > 0 && (
        <section className="mb-6">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-soft">
            {unmapped.length} message{unmapped.length === 1 ? "" : "s"} need an account assigned
          </p>
          <div className="rounded-2xl border border-hairline bg-surface p-4">
            {unmapped.map((a) => {
              const detail = a.detail as { acctKey: string; amount: string; date: string };
              return (
                <UnmappedRow
                  key={a.id}
                  anomalyId={a.id}
                  date={detail.date}
                  amount={detail.amount}
                  acctKey={detail.acctKey}
                  accounts={accountOptions}
                />
              );
            })}
          </div>
        </section>
      )}

      {/* Not recognized — informational, collapsed */}
      {unparsed.length > 0 && (
        <details className="mb-6">
          <summary className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-soft cursor-pointer">
            {unparsed.length} not recognized — probably OTPs or offers
          </summary>
          <div className="rounded-2xl border border-hairline bg-surface divide-y divide-hairline">
            {unparsed.map((a) => {
              const detail = a.detail as { sender?: string; body?: string };
              return (
                <div key={a.id} className="px-4 py-3 text-xs text-soft">
                  {detail.sender} · {detail.body?.slice(0, 80)}
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}
