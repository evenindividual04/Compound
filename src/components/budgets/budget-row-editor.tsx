"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { setAllocationAction } from "@/app/actions/budgets";
import { formatINR } from "@/lib/money";

interface Props {
  month: string;
  categoryId: string;
  assigned: string;
  /** Display label for the editable amount */
  label?: string;
}

export function BudgetAmountEditor({ month, categoryId, assigned, label }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(assigned === "0.0000" ? "" : String(parseFloat(assigned)));
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setValue(assigned === "0.0000" ? "" : String(parseFloat(assigned)));
    setEditing(true);
    // Focus on next tick after mount
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function cancel() {
    setEditing(false);
  }

  function save() {
    const parsed = parseFloat(value.replace(/,/g, ""));
    if (isNaN(parsed) || parsed < 0) {
      toast.error("Enter a valid amount");
      return;
    }
    const assignedStr = parsed.toFixed(4);
    startTransition(async () => {
      const res = await setAllocationAction(month, categoryId, assignedStr);
      if (res.ok) {
        toast.success("Budget updated");
        setEditing(false);
      } else {
        toast.error(res.error);
      }
    });
  }

  if (!editing) {
    return (
      <button
        onClick={startEdit}
        className="tnum text-right text-sm tabular-nums text-ink hover:text-primary transition-colors"
        aria-label="Edit budget amount"
      >
        {label ?? formatINR(assigned)}
      </button>
    );
  }

  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Input
        ref={inputRef}
        type="number"
        min="0"
        step="1"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-7 w-24 text-right text-sm tnum"
        onKeyDown={(e) => e.key === "Escape" && cancel()}
      />
      <Button type="submit" size="xs" disabled={pending}>
        Save
      </Button>
      <Button type="button" size="xs" variant="ghost" onClick={cancel} disabled={pending}>
        ✕
      </Button>
    </form>
  );
}
