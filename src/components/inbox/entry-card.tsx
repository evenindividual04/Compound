"use client";

import { useState, useTransition } from "react";
import { Check, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { CategoryPicker, type CategoryOption } from "@/components/category-picker";
import { formatINR } from "@/lib/money";
import { cmp } from "@/lib/money";
import { cn } from "@/lib/utils";
import { accept, recategorizeAndAccept } from "@/app/actions/inbox";
import type { PendingEntry } from "@/lib/ledger/inbox";
import { CategoryPickerDialog } from "./category-picker-dialog";

interface Props {
  entry: PendingEntry;
  categories: CategoryOption[];
  selected: boolean;
  selectMode: boolean;
  onToggleSelect: (id: string) => void;
}

export function EntryCard({ entry, categories, selected, selectMode, onToggleSelect }: Props) {
  const [pending, startTransition] = useTransition();
  const [recatOpen, setRecatOpen] = useState(false);

  const isIncome = cmp(entry.amount, "0") > 0;

  // The effective category to use when accepting: current > suggested > none
  const effectiveCategoryId = entry.categoryId ?? entry.suggestedCategoryId ?? undefined;
  const effectiveCategoryName =
    entry.categoryName ??
    (entry.suggestedCategoryId
      ? categories.find((c) => c.id === entry.suggestedCategoryId)?.name ?? null
      : null);

  const isSuggested = !entry.categoryId && !!entry.suggestedCategoryId;
  const needsCategory = !entry.categoryId && !entry.suggestedCategoryId;

  function handleAccept() {
    if (needsCategory) {
      setRecatOpen(true);
      return;
    }
    startTransition(async () => {
      try {
        await accept(entry.entryId, effectiveCategoryId);
        toast.success("Accepted");
      } catch {
        toast.error("Failed to accept entry");
      }
    });
  }

  function handleRecategorize(categoryId: string | null) {
    setRecatOpen(false);
    startTransition(async () => {
      try {
        if (categoryId) {
          await recategorizeAndAccept(entry.entryId, categoryId);
        } else {
          await accept(entry.entryId, undefined);
        }
        toast.success("Accepted");
      } catch {
        toast.error("Failed to accept entry");
      }
    });
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-2xl border border-hairline bg-surface p-3 transition-colors",
        selected && "ring-2 ring-primary",
        pending && "opacity-60",
      )}
    >
      {entry.isAdjustment && (
        <div className="flex items-center gap-1.5 rounded-lg bg-warn-bg px-2 py-1 text-xs text-warn-ink">
          <span className="font-medium">Reconciliation gap</span>
          <span className="text-soft">on {entry.accountName} · {entry.date}</span>
        </div>
      )}

      <div className="flex items-start gap-2">
        {selectMode && (
          <button
            type="button"
            onClick={() => onToggleSelect(entry.entryId)}
            className={cn(
              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-hairline transition-colors",
              selected && "border-primary bg-primary text-primary-foreground",
            )}
            aria-checked={selected}
            role="checkbox"
          >
            {selected && <Check className="h-3 w-3" />}
          </button>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-ink">
              {entry.merchant || entry.description || "—"}
            </span>
            <span
              className={cn(
                "tnum shrink-0 text-sm font-semibold",
                isIncome ? "text-money-pos" : "text-ink",
              )}
            >
              {formatINR(entry.amount)}
            </span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-soft">{entry.accountName}</span>
            <span className="text-[11px] text-soft">·</span>
            <span className="text-[11px] text-soft">{entry.date}</span>

            {effectiveCategoryName && (
              <Badge
                variant={isSuggested ? "outline" : "secondary"}
                className={cn("text-[10px]", isSuggested && "border-dashed")}
              >
                {isSuggested ? `suggested: ${effectiveCategoryName}` : effectiveCategoryName}
              </Badge>
            )}
            {needsCategory && (
              <Badge variant="outline" className="border-dashed text-[10px] text-soft">
                needs category
              </Badge>
            )}
          </div>
        </div>
      </div>

      {!selectMode && (
        <div className="flex items-center justify-end gap-2">
          <CategoryPickerDialog
            open={recatOpen}
            onOpenChange={setRecatOpen}
            categories={categories}
            currentValue={entry.categoryId}
            onSelect={handleRecategorize}
            trigger={
              <Button variant="ghost" size="xs" disabled={pending}>
                <RefreshCw className="h-3 w-3" />
                Recategorize
              </Button>
            }
          />
          <Button
            size="xs"
            onClick={handleAccept}
            disabled={pending}
          >
            <Check className="h-3 w-3" />
            Accept
          </Button>
        </div>
      )}
    </div>
  );
}
