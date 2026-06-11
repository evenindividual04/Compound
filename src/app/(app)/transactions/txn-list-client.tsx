"use client";

import { useState, useMemo } from "react";
import { TxnRowItem, type TxnRow } from "@/components/txn-row";
import { TxnEditDrawer } from "@/components/txn-edit-drawer";
import type { CategoryOption } from "@/components/category-picker";
import { neg } from "@/lib/money";

interface TransferCandidate {
  entryId: string;
  description: string;
  amount: string;
  date: string;
  accountName: string;
}

interface Props {
  rows: TxnRow[];
  categories: CategoryOption[];
  month: string;
}

export function TxnListClient({ rows, categories, month }: Props) {
  const [selected, setSelected] = useState<TxnRow | null>(null);

  // For the selected row, compute transfer candidates from the same page's rows:
  // entries where amount == neg(selected.amount), different account, within ±3 days,
  // and not already a transfer leg.
  const transferCandidates = useMemo((): TransferCandidate[] => {
    if (!selected || selected.isTransferLeg) return [];
    const targetAmount = neg(selected.amount);
    const selDate = new Date(selected.date).getTime();
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

    return rows
      .filter((r) => {
        if (r.entryId === selected.entryId) return false;
        if (r.isTransferLeg) return false;
        if (r.accountName === selected.accountName) return false;
        if (r.amount !== targetAmount) return false;
        const diff = Math.abs(new Date(r.date).getTime() - selDate);
        return diff <= THREE_DAYS_MS;
      })
      .map((r) => ({
        entryId: r.entryId,
        description: r.description,
        amount: r.amount,
        date: r.date,
        accountName: r.accountName,
      }));
  }, [selected, rows]);

  return (
    <>
      <div className="divide-y divide-border">
        {rows.map((row) => (
          <TxnRowItem key={row.entryId} row={row} onClick={setSelected} />
        ))}
      </div>

      <TxnEditDrawer
        key={selected?.entryId ?? "none"}
        row={selected}
        categories={categories}
        transferCandidates={transferCandidates}
        open={selected !== null}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
