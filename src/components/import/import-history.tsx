"use client";

import { useState, useTransition } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { undoImportAction } from "@/app/actions/import";
import type { ImportHistoryItem } from "@/app/actions/import";

const STATUS_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  staged: "secondary",
  committed: "default",
  undone: "outline",
  failed: "destructive",
  parsing: "secondary",
};

function UndoButton({
  importId,
  onDone,
}: {
  importId: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleUndo() {
    startTransition(async () => {
      try {
        const { deleted, skipped } = await undoImportAction(importId);
        toast.success(
          `Undone — ${deleted} transaction${deleted !== 1 ? "s" : ""} removed${skipped > 0 ? `, ${skipped} transfer leg${skipped !== 1 ? "s" : ""} skipped` : ""}`,
        );
        setOpen(false);
        onDone();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Undo failed");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button variant="ghost" size="icon-sm" title="Undo import"><RotateCcw className="size-3.5" /></Button>}
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Undo import?</DialogTitle>
          <DialogDescription>
            This will soft-delete all transactions created by this import. Transfer-linked entries
            will be skipped and can be undone after dissolving the transfer.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="destructive" onClick={handleUndo} disabled={isPending}>
            {isPending ? "Undoing…" : "Yes, undo"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ImportHistory({
  items,
  onRefresh,
}: {
  items: ImportHistoryItem[];
  onRefresh: () => void;
}) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-soft text-center py-6">No imports yet.</p>
    );
  }

  return (
    <div className="divide-y divide-hairline">
      {items.map((item) => (
        <div key={item.id} className="flex items-start justify-between gap-2 py-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-ink truncate">{item.filename}</span>
              <Badge variant={STATUS_BADGE[item.status] ?? "secondary"} className="shrink-0">
                {item.status}
              </Badge>
            </div>
            <div className="text-xs text-soft mt-0.5 flex flex-wrap gap-x-3">
              <span>{item.accountName}</span>
              <span>
                {new Date(item.createdAt).toLocaleDateString("en-IN", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })}
              </span>
              {item.stats && (
                <span className="tnum">
                  {item.stats.total} rows · {item.stats.new} new · {item.stats.duplicates} dup
                  {item.stats.suspicious > 0 ? ` · ${item.stats.suspicious} suspicious` : ""}
                </span>
              )}
            </div>
          </div>
          {item.status === "committed" && (
            <UndoButton importId={item.id} onDone={onRefresh} />
          )}
        </div>
      ))}
    </div>
  );
}
