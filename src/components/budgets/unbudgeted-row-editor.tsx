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
  categoryName: string;
  spent: string;
}

export function UnbudgetedRowEditor({ month, categoryId, categoryName, spent }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setValue("");
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function cancel() {
    setEditing(false);
  }

  function save() {
    const parsed = parseFloat(value.replace(/,/g, ""));
    if (isNaN(parsed) || parsed <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    const assignedStr = parsed.toFixed(4);
    startTransition(async () => {
      const res = await setAllocationAction(month, categoryId, assignedStr);
      if (res.ok) {
        toast.success(`Budget set for ${categoryName}`);
        setEditing(false);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="flex items-center justify-between gap-2 py-2">
      <div className="flex-1 min-w-0">
        <span className="text-sm text-foreground truncate">{categoryName}</span>
      </div>
      <span className="tnum text-sm text-muted-foreground tabular-nums shrink-0">
        {formatINR(spent)}
      </span>
      {editing ? (
        <form
          className="flex items-center gap-1 shrink-0"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input
            ref={inputRef}
            type="number"
            min="1"
            step="1"
            placeholder="Amount"
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
      ) : (
        <Button variant="outline" size="xs" onClick={startEdit} className="shrink-0">
          Set budget
        </Button>
      )}
    </div>
  );
}
