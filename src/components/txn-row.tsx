"use client";

import { ArrowLeftRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";
import { cmp } from "@/lib/money";

export interface TxnRow {
  entryId: string;
  date: string;
  description: string;
  merchant: string | null;
  categoryId: string | null;
  categoryName: string | null;
  accountName: string;
  amount: string;
  status: "pending" | "posted" | "reconciled";
  isTransferLeg: boolean;
}

interface Props {
  row: TxnRow;
  onClick: (row: TxnRow) => void;
}

export function TxnRowItem({ row, onClick }: Props) {
  const isIncome = cmp(row.amount, "0") > 0;
  const isTransfer = row.isTransferLeg;
  const isPending = row.status === "pending";

  return (
    <button
      type="button"
      onClick={() => onClick(row)}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted active:bg-muted/80"
    >
      {/* Left: description + meta */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-ink">
            {row.merchant || row.description || "—"}
          </span>
          {isPending && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              pending
            </Badge>
          )}
          {isTransfer && (
            <Badge variant="secondary" className="shrink-0 gap-0.5 text-[10px]">
              <ArrowLeftRight className="h-2.5 w-2.5" />
              transfer
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          {row.categoryName && !isTransfer ? (
            <Badge variant="outline" className="text-[10px]">
              {row.categoryName}
            </Badge>
          ) : !isTransfer ? (
            <span className="text-[11px] text-soft italic">uncategorized</span>
          ) : null}
          <span className="text-[11px] text-soft">{row.accountName}</span>
          <span className="text-[11px] text-soft">{row.date}</span>
        </div>
      </div>

      {/* Right: amount */}
      <span
        className={cn(
          "tnum shrink-0 text-sm font-medium",
          isTransfer
            ? "text-soft"
            : isIncome
              ? "text-money-pos"
              : "text-money-neg",
        )}
      >
        {formatINR(row.amount)}
      </span>
    </button>
  );
}
