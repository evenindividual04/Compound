"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { backfillCategoriesAction } from "@/app/actions/categorize";

export function BackfillButton() {
  const [pending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const result = await backfillCategoriesAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const { resolved, abstained, scanned } = result;
      if (scanned === 0) {
        toast.info("Nothing to categorize.");
      } else {
        toast.success(`Categorized ${resolved} of ${scanned} transactions.${abstained > 0 ? ` ${abstained} skipped.` : ""}`);
      }
    });
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={handleClick}
    >
      {pending ? "Categorizing…" : "Categorize uncategorized"}
    </Button>
  );
}
