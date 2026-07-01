import Link from "next/link";
import type { NeedsAttention } from "@/lib/ledger/dashboard";

interface UrgentCardProps {
  attention: NeedsAttention;
}

export function UrgentCards({ attention }: UrgentCardProps) {
  const hasInbox = attention.inbox > 0;
  const hasStale = attention.staleAnchors.length > 0;
  const showNoAccounts = !attention.hasAccounts;
  const showConnectSync = attention.hasAccounts && attention.bridgeStatus === "never";
  const showSyncStale = attention.hasAccounts && attention.bridgeStatus === "stale";
  const showUnmapped = attention.unmappedCount > 0;

  const nothingToShow =
    !hasInbox && !hasStale && !showNoAccounts && !showConnectSync && !showSyncStale && !showUnmapped;
  if (nothingToShow) return null;

  return (
    <div className="flex flex-col gap-2 px-4 mb-2">
      {showNoAccounts && (
        <Link
          href="/accounts/new"
          className="flex items-center justify-between rounded-2xl bg-surface border border-hairline overflow-hidden"
          style={{ borderLeftWidth: "3px", borderLeftColor: "var(--coral)" }}
        >
          <div className="px-4 py-3 flex-1">
            <p
              className="text-[9px] font-semibold uppercase tracking-[0.12em] text-soft mb-0.5"
              style={{ letterSpacing: "0.12em" }}
            >
              Setup
            </p>
            <p className="text-[13px] font-semibold text-ink leading-snug">No accounts yet</p>
          </div>
          <span className="text-[11px] font-semibold text-coral pr-4">Add your first account →</span>
        </Link>
      )}

      {showConnectSync && (
        <Link
          href="/browse/setup"
          className="flex items-center justify-between rounded-2xl bg-surface border border-hairline overflow-hidden"
          style={{ borderLeftWidth: "3px", borderLeftColor: "var(--coral)" }}
        >
          <div className="px-4 py-3 flex-1">
            <p
              className="text-[9px] font-semibold uppercase tracking-[0.12em] text-soft mb-0.5"
              style={{ letterSpacing: "0.12em" }}
            >
              Setup
            </p>
            <p className="text-[13px] font-semibold text-ink leading-snug">Connect SMS sync</p>
          </div>
          <span className="text-[11px] font-semibold text-coral pr-4">Set it up →</span>
        </Link>
      )}

      {showSyncStale && (
        <Link
          href="/browse/setup"
          className="flex items-center justify-between rounded-2xl bg-surface border border-hairline overflow-hidden"
          style={{ borderLeftWidth: "3px", borderLeftColor: "var(--coral)" }}
        >
          <div className="px-4 py-3 flex-1">
            <p
              className="text-[9px] font-semibold uppercase tracking-[0.12em] text-soft mb-0.5"
              style={{ letterSpacing: "0.12em" }}
            >
              Setup
            </p>
            <p className="text-[13px] font-semibold text-ink leading-snug">
              SMS sync hasn&apos;t checked in
            </p>
          </div>
          <span className="text-[11px] font-semibold text-coral pr-4">Check status →</span>
        </Link>
      )}

      {showUnmapped && (
        <Link
          href="/browse/setup"
          className="flex items-center justify-between rounded-2xl bg-surface border border-hairline overflow-hidden"
          style={{ borderLeftWidth: "3px", borderLeftColor: "var(--coral)" }}
        >
          <div className="px-4 py-3 flex-1">
            <p
              className="text-[9px] font-semibold uppercase tracking-[0.12em] text-soft mb-0.5"
              style={{ letterSpacing: "0.12em" }}
            >
              Setup
            </p>
            <p className="text-[13px] font-semibold text-ink leading-snug">
              {attention.unmappedCount} message{attention.unmappedCount === 1 ? "" : "s"}{" "}
              {attention.unmappedCount === 1 ? "needs" : "need"} an account
            </p>
          </div>
          <span className="text-[11px] font-semibold text-coral pr-4">Assign them →</span>
        </Link>
      )}

      {hasInbox && (
        <Link
          href="/inbox"
          className="flex items-center justify-between rounded-2xl bg-surface border border-hairline overflow-hidden"
          style={{ borderLeftWidth: "3px", borderLeftColor: "var(--coral)" }}
        >
          <div className="px-4 py-3 flex-1">
            <p
              className="text-[9px] font-semibold uppercase tracking-[0.12em] text-soft mb-0.5"
              style={{ letterSpacing: "0.12em" }}
            >
              Inbox
            </p>
            <p className="text-[13px] font-semibold text-ink leading-snug">
              {attention.inbox} to review
            </p>
          </div>
          <span className="text-[11px] font-semibold text-coral pr-4">Review inbox →</span>
        </Link>
      )}

      {attention.staleAnchors.map((anchor) => (
        <Link
          key={anchor.accountId}
          href={`/accounts/${anchor.accountId}`}
          className="flex items-center justify-between rounded-2xl bg-surface border border-hairline overflow-hidden"
          style={{ borderLeftWidth: "3px", borderLeftColor: "var(--coral)" }}
        >
          <div className="px-4 py-3 flex-1">
            <p
              className="text-[9px] font-semibold uppercase tracking-[0.12em] text-soft mb-0.5"
              style={{ letterSpacing: "0.12em" }}
            >
              Accounts
            </p>
            <p className="text-[13px] font-semibold text-ink leading-snug">
              Update {anchor.accountName} balance
            </p>
          </div>
          <span className="text-[11px] font-semibold text-coral pr-4">Accounts →</span>
        </Link>
      ))}
    </div>
  );
}
