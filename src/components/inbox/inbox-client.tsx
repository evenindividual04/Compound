"use client";

import { useState, useTransition } from "react";
import { CheckSquare, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { acceptBulk } from "@/app/actions/inbox";
import type { PendingEntry, PendingTransfer } from "@/lib/ledger/inbox";
import type { CategoryOption } from "@/components/category-picker";
import { EntryCard } from "./entry-card";
import { TransferCard } from "./transfer-card";

interface Props {
  pendingEntries: PendingEntry[];
  pendingTransfers: PendingTransfer[];
  categories: CategoryOption[];
}

export function InboxClient({ pendingEntries, pendingTransfers, categories }: Props) {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPending, startBulk] = useTransition();

  const total = pendingEntries.length + pendingTransfers.length;

  if (total === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-24 text-center">
        <CheckSquare className="h-12 w-12 text-muted-foreground/40" />
        <p className="text-lg font-medium text-muted-foreground">All caught up ✓</p>
        <p className="text-sm text-muted-foreground">Nothing pending review.</p>
      </div>
    );
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectMode() {
    setSelectMode((v) => {
      if (v) setSelected(new Set()); // clear on exit
      return !v;
    });
  }

  function selectAll() {
    setSelected(new Set(pendingEntries.map((e) => e.entryId)));
  }

  function handleAcceptSelected() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    startBulk(async () => {
      try {
        await acceptBulk(ids);
        setSelected(new Set());
        setSelectMode(false);
        toast.success(`Accepted ${ids.length} ${ids.length === 1 ? "entry" : "entries"}`);
      } catch {
        toast.error("Failed to accept entries");
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Transactions section */}
      {pendingEntries.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Transactions{" "}
              <span className="ml-1 text-foreground">{pendingEntries.length}</span>
            </h2>
            <div className="flex items-center gap-2">
              {selectMode && (
                <Button variant="ghost" size="xs" onClick={selectAll}>
                  Select all
                </Button>
              )}
              <Button
                variant={selectMode ? "secondary" : "outline"}
                size="xs"
                onClick={toggleSelectMode}
              >
                {selectMode ? (
                  <>
                    <Square className="h-3 w-3" />
                    Cancel
                  </>
                ) : (
                  <>
                    <CheckSquare className="h-3 w-3" />
                    Select
                  </>
                )}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {pendingEntries.map((entry) => (
              <EntryCard
                key={entry.entryId}
                entry={entry}
                categories={categories}
                selected={selected.has(entry.entryId)}
                selectMode={selectMode}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>
        </section>
      )}

      {/* Transfers section */}
      {pendingTransfers.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Transfers{" "}
            <span className="ml-1 text-foreground">{pendingTransfers.length}</span>
          </h2>
          <div className="flex flex-col gap-2">
            {pendingTransfers.map((t) => (
              <TransferCard key={t.transferId} transfer={t} />
            ))}
          </div>
        </section>
      )}

      {/* Bulk accept bar */}
      {selectMode && selected.size > 0 && (
        <div className="fixed bottom-20 left-0 right-0 z-40 flex justify-center px-4">
          <div className="flex w-full max-w-sm items-center justify-between gap-3 rounded-xl border border-border bg-card/95 px-4 py-3 shadow-lg backdrop-blur">
            <span className="text-sm font-medium">
              {selected.size} selected
            </span>
            <Button size="sm" onClick={handleAcceptSelected} disabled={bulkPending}>
              <CheckSquare className="h-4 w-4" />
              Accept {selected.size}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
