"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Trash2, ArrowLeftRight, Plus, Minus } from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerFooter,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CategoryPicker, type CategoryOption } from "@/components/category-picker";
import {
  recategorize,
  editDescription,
  removeTransaction,
  saveSplits,
  pairTransfer,
} from "@/app/actions/transactions";
import { formatINR, allocate } from "@/lib/money";
import type { TxnRow } from "@/components/txn-row";

interface TransferCandidate {
  entryId: string;
  description: string;
  amount: string;
  date: string;
  accountName: string;
}

interface Props {
  row: TxnRow | null;
  categories: CategoryOption[];
  transferCandidates: TransferCandidate[];
  open: boolean;
  onClose: () => void;
}

interface SplitLine {
  categoryId: string | null;
  amount: string;
  note: string;
}

export function TxnEditDrawer({
  row,
  categories,
  transferCandidates,
  open,
  onClose,
}: Props) {
  const [isPending, startTransition] = useTransition();

  // Local edit state (reset when row changes, handled by key in parent)
  const [description, setDescription] = useState(row?.description ?? "");
  const [categoryId, setCategoryId] = useState<string | null>(row?.categoryId ?? null);
  const [splits, setSplitsLocal] = useState<SplitLine[]>([]);
  const [splitMode, setSplitMode] = useState(false);
  const [transferPanel, setTransferPanel] = useState(false);

  if (!row) return null;

  const isTransferLeg = row.isTransferLeg;

  function handleSaveCategory(newCategoryId: string | null) {
    setCategoryId(newCategoryId);
    startTransition(async () => {
      const res = await recategorize(row!.entryId, newCategoryId);
      if (!res.ok) toast.error(res.error);
      else toast.success("Category updated");
    });
  }

  function handleSaveDescription() {
    startTransition(async () => {
      const res = await editDescription(row!.entryId, description);
      if (!res.ok) toast.error(res.error);
      else toast.success("Description updated");
    });
  }

  function handleDelete() {
    if (!confirm("Delete this transaction?")) return;
    startTransition(async () => {
      const res = await removeTransaction(row!.entryId);
      if (!res.ok) {
        toast.error(res.error);
      } else {
        toast.success("Transaction deleted");
        onClose();
      }
    });
  }

  function initSplits() {
    const parts = allocate(row!.amount, 2);
    setSplitsLocal([
      { categoryId: null, amount: parts[0], note: "" },
      { categoryId: null, amount: parts[1], note: "" },
    ]);
    setSplitMode(true);
  }

  function addSplitLine() {
    setSplitsLocal((prev) => [...prev, { categoryId: null, amount: "0.0000", note: "" }]);
  }

  function removeSplitLine(idx: number) {
    setSplitsLocal((prev) => prev.filter((_, i) => i !== idx));
  }

  function setSplitEven() {
    const n = splits.length || 2;
    const parts = allocate(row!.amount, n);
    setSplitsLocal((prev) =>
      prev.map((s, i) => ({ ...s, amount: parts[i] ?? "0.0000" })),
    );
  }

  function handleSaveSplits() {
    startTransition(async () => {
      const res = await saveSplits(row!.entryId, splits);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success("Splits saved");
        setSplitMode(false);
      }
    });
  }

  function handleClearSplits() {
    startTransition(async () => {
      const res = await saveSplits(row!.entryId, []);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success("Splits cleared");
        setSplitsLocal([]);
        setSplitMode(false);
      }
    });
  }

  function handlePairTransfer(candidateId: string) {
    // row.amount < 0 means this is the outflow
    const [outflowId, inflowId] =
      parseFloat(row!.amount) < 0
        ? [row!.entryId, candidateId]
        : [candidateId, row!.entryId];

    startTransition(async () => {
      const res = await pairTransfer(outflowId, inflowId);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success("Transfer paired");
        setTransferPanel(false);
        onClose();
      }
    });
  }

  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} direction="bottom">
      <DrawerContent className="max-h-[90vh] overflow-y-auto">
        <DrawerHeader>
          <DrawerTitle className="truncate">
            {row.merchant || row.description || "Transaction"}
          </DrawerTitle>
          <p className="tnum text-center text-2xl font-semibold">
            {formatINR(row.amount)}
          </p>
          <p className="text-center text-xs text-muted-foreground">
            {row.accountName} · {row.date}
          </p>
        </DrawerHeader>

        <div className="flex flex-col gap-4 px-4 pb-2">
          {/* Description */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">Description</label>
            <div className="flex gap-2">
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="flex-1 text-sm"
                maxLength={255}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={isPending}
                onClick={handleSaveDescription}
              >
                Save
              </Button>
            </div>
          </div>

          {/* Category picker */}
          {!isTransferLeg && !splitMode && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Category</label>
              <CategoryPicker
                categories={categories}
                value={categoryId}
                onSelect={handleSaveCategory}
              />
            </div>
          )}

          {/* Splits editor */}
          {!isTransferLeg && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Splits</span>
                <div className="flex gap-1">
                  {splitMode && (
                    <>
                      <Button size="xs" variant="ghost" onClick={setSplitEven} disabled={isPending}>
                        Split evenly
                      </Button>
                      <Button size="xs" variant="ghost" onClick={addSplitLine} disabled={isPending}>
                        <Plus className="h-3 w-3" />
                      </Button>
                    </>
                  )}
                  {!splitMode && (
                    <Button size="xs" variant="ghost" onClick={initSplits}>
                      Add splits
                    </Button>
                  )}
                </div>
              </div>

              {splitMode && (
                <div className="flex flex-col gap-2">
                  {splits.map((line, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <div className="flex-1">
                        <CategoryPicker
                          categories={categories}
                          value={line.categoryId}
                          onSelect={(id) =>
                            setSplitsLocal((prev) =>
                              prev.map((s, i) => (i === idx ? { ...s, categoryId: id } : s)),
                            )
                          }
                        />
                      </div>
                      <Input
                        className="w-28 tnum text-right text-sm"
                        value={line.amount}
                        onChange={(e) =>
                          setSplitsLocal((prev) =>
                            prev.map((s, i) =>
                              i === idx ? { ...s, amount: e.target.value } : s,
                            ),
                          )
                        }
                      />
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => removeSplitLine(idx)}
                        disabled={splits.length <= 1}
                      >
                        <Minus className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}

                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      className="flex-1"
                      disabled={isPending}
                      onClick={handleSaveSplits}
                    >
                      Save splits
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isPending}
                      onClick={handleClearSplits}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Make transfer panel */}
          {!isTransferLeg && transferCandidates.length > 0 && (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
                onClick={() => setTransferPanel((p) => !p)}
              >
                <ArrowLeftRight className="h-3.5 w-3.5" />
                Mark as transfer
              </button>
              {transferPanel && (
                <div className="flex flex-col gap-1">
                  {transferCandidates.map((c) => (
                    <button
                      key={c.entryId}
                      type="button"
                      className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
                      onClick={() => handlePairTransfer(c.entryId)}
                      disabled={isPending}
                    >
                      <span className="truncate">
                        {c.description || c.accountName}
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {c.accountName} · {c.date}
                        </span>
                      </span>
                      <span className="tnum ml-2 shrink-0 text-xs">
                        {formatINR(c.amount)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DrawerFooter>
          {isTransferLeg && (
            <Badge variant="secondary" className="mx-auto mb-2 flex w-fit gap-1">
              <ArrowLeftRight className="h-3 w-3" />
              Transfer — dissolve transfer to delete
            </Badge>
          )}
          <Button
            variant="destructive"
            size="sm"
            disabled={isPending}
            onClick={handleDelete}
            className="w-full"
          >
            <Trash2 className="h-4 w-4" />
            Delete transaction
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
