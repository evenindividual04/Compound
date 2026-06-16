"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createAccount } from "@/app/actions/accounts";
import { LIABILITY_KINDS } from "@/db/schema/core";
import { KIND_LABELS, ALL_KINDS } from "./kind-labels";

export function NewAccountForm({ today }: { today: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>("bank");
  const [balanceAbs, setBalanceAbs] = useState("0");
  const [openingDate, setOpeningDate] = useState(today);

  const isLiability = (LIABILITY_KINDS as readonly string[]).includes(kind);
  const balanceLabel = isLiability ? "Current amount owed" : "Opening balance";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        await createAccount({ name, kind, openingBalanceAbs: balanceAbs, openingDate });
        toast.success("Account created");
        router.push("/accounts");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to create account");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Account name */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-soft" htmlFor="name">
          Account name
        </label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. HDFC Savings"
          required
        />
      </div>

      {/* Kind */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-soft">Account type</label>
        <Select value={kind} onValueChange={(v) => { if (v !== null) setKind(v); }}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select type" />
          </SelectTrigger>
          <SelectContent>
            {ALL_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Opening balance / amount owed */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-soft" htmlFor="balance">
          {balanceLabel}
        </label>
        <Input
          id="balance"
          type="number"
          min="0"
          step="0.01"
          value={balanceAbs}
          onChange={(e) => setBalanceAbs(e.target.value)}
          className="tnum"
          placeholder="0"
        />
      </div>

      {/* Opening date */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-soft" htmlFor="openingDate">
          Opening date
        </label>
        <Input
          id="openingDate"
          type="date"
          value={openingDate}
          onChange={(e) => setOpeningDate(e.target.value)}
          required
        />
      </div>

      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? "Creating…" : "Create account"}
      </Button>
    </form>
  );
}
