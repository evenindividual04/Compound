"use client";

import { useState, useCallback, useTransition, useEffect } from "react";
import { Upload } from "lucide-react";
import { ImportWizard } from "./import-wizard";
import { ImportHistory } from "./import-history";
import { getImportHistory } from "@/app/actions/import";
import type { ImportHistoryItem } from "@/app/actions/import";

interface Account {
  id: string;
  name: string;
  kind: string;
}

export function ImportPageClient({ accounts }: { accounts: Account[] }) {
  const [history, setHistory] = useState<ImportHistoryItem[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [wizardKey, setWizardKey] = useState(0);
  const [isPending, startTransition] = useTransition();

  const refreshHistory = useCallback(() => {
    startTransition(async () => {
      const items = await getImportHistory();
      setHistory(items);
      setHistoryLoaded(true);
    });
  }, []);

  // Load history on mount (must be in useEffect — cannot call startTransition during render)
  useEffect(() => {
    if (!historyLoaded) refreshHistory();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleWizardDone() {
    // Reset wizard and refresh history
    setWizardKey((k) => k + 1);
    refreshHistory();
  }

  return (
    <div className="min-h-screen bg-paper px-4 pt-12 pb-8 space-y-8">
      {/* Header */}
      <section className="flex items-center gap-2">
        <Upload className="size-5 text-soft" />
        <h1 className="font-display text-3xl font-bold text-ink">Import statement</h1>
      </section>

      {/* Wizard */}
      <section className="bg-surface border border-hairline rounded-2xl p-4">
        <ImportWizard
          key={wizardKey}
          accounts={accounts}
          onDone={handleWizardDone}
        />
      </section>

      {/* Import history */}
      <section>
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-soft mb-3">
          Import history
        </h2>
        {isPending && !historyLoaded ? (
          <div className="text-sm text-soft py-4 text-center">Loading…</div>
        ) : (
          <ImportHistory items={history} onRefresh={refreshHistory} />
        )}
      </section>
    </div>
  );
}
