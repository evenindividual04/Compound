"use client";

import { useTransition } from "react";
import { ArrowRight, Check, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatINR } from "@/lib/money";
import { abs } from "@/lib/money";
import { cn } from "@/lib/utils";
import { confirmTransferAction, rejectTransferAction } from "@/app/actions/inbox";
import type { PendingTransfer } from "@/lib/ledger/inbox";

interface Props {
  transfer: PendingTransfer;
}

export function TransferCard({ transfer }: Props) {
  const [pending, startTransition] = useTransition();

  function handleConfirm() {
    startTransition(async () => {
      try {
        await confirmTransferAction(transfer.transferId);
        toast.success("Transfer confirmed");
      } catch {
        toast.error("Failed to confirm transfer");
      }
    });
  }

  function handleReject() {
    startTransition(async () => {
      try {
        await rejectTransferAction(transfer.transferId);
        toast.success("Marked: not a transfer");
      } catch {
        toast.error("Failed to reject transfer");
      }
    });
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-2xl border border-hairline bg-surface p-3 transition-colors",
        pending && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm">
            <span className="font-medium text-ink truncate">{transfer.outflow.accountName}</span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-soft" />
            <span className="font-medium text-ink truncate">{transfer.inflow.accountName}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-soft">
            <span className="tnum">{formatINR(abs(transfer.outflow.amount))}</span>
            <span>·</span>
            <span>{transfer.outflow.date}</span>
            {transfer.outflow.date !== transfer.inflow.date && (
              <>
                <span>→</span>
                <span>{transfer.inflow.date}</span>
              </>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-soft truncate">
            {transfer.outflow.description || transfer.inflow.description || "Transfer"}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="xs" onClick={handleReject} disabled={pending}>
          <X className="h-3 w-3" />
          Not a transfer
        </Button>
        <Button size="xs" onClick={handleConfirm} disabled={pending}>
          <Check className="h-3 w-3" />
          Confirm ⇄
        </Button>
      </div>
    </div>
  );
}
