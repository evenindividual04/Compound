"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { resolveUnmappedAnomaly } from "@/app/actions/anomalies";
import { formatINR } from "@/lib/money";

interface AccountOption {
  id: string;
  name: string;
}

interface UnmappedRowProps {
  anomalyId: string;
  date: string;
  amount: string; // signed 4dp string
  acctKey: string;
  accounts: AccountOption[];
}

export function UnmappedRow({ anomalyId, date, amount, acctKey, accounts }: UnmappedRowProps) {
  const [accountId, setAccountId] = useState<string>("");
  const [pending, startTransition] = useTransition();
  const [resolved, setResolved] = useState(false);

  function handleResolve() {
    if (!accountId) {
      toast.error("Pick an account first");
      return;
    }
    startTransition(async () => {
      const result = await resolveUnmappedAnomaly(anomalyId, accountId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Assigned. Now sitting in your review inbox.");
      setResolved(true);
    });
  }

  if (resolved) return null;

  return (
    <div className="flex items-center justify-between gap-2 py-2 border-b border-hairline last:border-0">
      <div className="flex-1 text-[13px] text-ink">
        <span className="tnum">{formatINR(amount)}</span>
        <span className="text-soft"> · {date} · {acctKey}</span>
      </div>
      <Select value={accountId} onValueChange={(v) => { if (v !== null) setAccountId(v); }}>
        <SelectTrigger className="w-[140px]">
          <SelectValue placeholder="Account" />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" disabled={pending} onClick={handleResolve}>
        {pending ? "…" : "Resolve"}
      </Button>
    </div>
  );
}
