"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addValuation } from "@/app/actions/accounts";
import { LIABILITY_KINDS } from "@/db/schema/core";
import { formatINR } from "@/lib/money";

interface Props {
  accountId: string;
  kind: string;
  today: string;
}

export function UpdateBalanceForm({ accountId, kind, today }: Props) {
  const [isPending, startTransition] = useTransition();
  const [date, setDate] = useState(today);
  const [amountAbs, setAmountAbs] = useState("");

  const isLiability = (LIABILITY_KINDS as readonly string[]).includes(kind);
  const label = isLiability ? "Current amount owed" : "Current balance";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        const result = await addValuation({ accountId, date, amountAbs });
        if (result.adjustment !== null) {
          toast.info(
            `Adjustment of ${formatINR(result.adjustment)} created — categorize it in Inbox`,
          );
        } else {
          toast.success("Balance confirmed ✓");
        }
        setAmountAbs("");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update balance");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-soft" htmlFor="valDate">
          Date
        </label>
        <Input
          id="valDate"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-soft" htmlFor="valAmount">
          {label}
        </label>
        <Input
          id="valAmount"
          type="number"
          min="0"
          step="0.01"
          value={amountAbs}
          onChange={(e) => setAmountAbs(e.target.value)}
          className="tnum"
          placeholder="0.00"
          required
        />
      </div>
      <Button type="submit" disabled={isPending} className="w-full">
        {isPending ? "Saving…" : "Update balance"}
      </Button>
    </form>
  );
}
