"use client";

/**
 * ImportWizard — 4-step import flow:
 *  1. Pick account + upload file → parse
 *  2. Map columns → live preview of first 5 rows
 *  3. Stage → preview verdicts (new/duplicate/suspicious)
 *  4. Commit → success toast
 */

import React, { useState, useTransition } from "react";
import { toast } from "sonner";
import { UploadCloud, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { formatINR, cmp } from "@/lib/money";
import {
  parseUpload,
  stageWithMapping,
  commitImportAction,
  getImportRows,
} from "@/app/actions/import";
import type { ColumnMapping, DateFormat } from "@/lib/import/mapping";
import type { ImportRowPreview } from "@/app/actions/import";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Account {
  id: string;
  name: string;
  kind: string;
}

interface ParseState {
  headers: string[];
  sampleRows: string[][];
  allRows: string[][];
  savedMapping: ColumnMapping | null;
}

interface StageState {
  importId: string;
  stats: { total: number; new: number; duplicates: number; suspicious: number };
  failed: { ordinal: number; reason: string }[];
  previewRows: ImportRowPreview[];
}

// ── Date format options ───────────────────────────────────────────────────────

const DATE_FORMATS: { value: DateFormat; label: string }[] = [
  { value: "dd/MM/yyyy", label: "DD/MM/YYYY (e.g. 01/07/2026)" },
  { value: "dd/MM/yy", label: "DD/MM/YY (e.g. 01/07/26)" },
  { value: "dd-MM-yyyy", label: "DD-MM-YYYY (e.g. 01-07-2026)" },
  { value: "yyyy-MM-dd", label: "YYYY-MM-DD (e.g. 2026-07-01)" },
  { value: "dd MMM yyyy", label: "DD MMM YYYY (e.g. 01 Jul 2026)" },
];

// ── Column role selects ───────────────────────────────────────────────────────

type MappingRole = keyof Omit<ColumnMapping, "dateFormat">;
const REQUIRED_ROLES: MappingRole[] = ["date", "description"];
const OPTIONAL_ROLES: Array<{ key: MappingRole; label: string }> = [
  { key: "amount", label: "Amount (single col.)" },
  { key: "debit", label: "Debit / Withdrawal" },
  { key: "credit", label: "Credit / Deposit" },
  { key: "balance", label: "Closing Balance" },
  { key: "ref", label: "Ref / Cheque No." },
];

function blankMapping(dateFormat: DateFormat = "dd/MM/yyyy"): ColumnMapping {
  return { date: "", description: "", dateFormat };
}

// ── Live preview table ────────────────────────────────────────────────────────

function PreviewTable({
  headers,
  sampleRows,
}: {
  headers: string[];
  sampleRows: string[][];
}) {
  if (sampleRows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-xl border border-hairline text-xs">
      <table className="w-full">
        <thead>
          <tr className="border-b border-hairline bg-paper">
            {headers.map((h, i) => (
              <th key={i} className="px-2 py-1 text-left font-semibold uppercase tracking-[0.08em] text-soft">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {sampleRows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} className="px-2 py-1 tnum text-ink">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Verdict preview ───────────────────────────────────────────────────────────

function VerdictSection({
  verdict,
  rows,
}: {
  verdict: "new" | "duplicate" | "suspicious";
  rows: ImportRowPreview[];
}) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;

  const color = verdict === "new" ? "default" : verdict === "duplicate" ? "secondary" : "destructive";
  const iconClass =
    verdict === "new"
      ? "text-money-pos"
      : verdict === "suspicious"
      ? "text-warn-ink"
      : "text-money-neg";
  const icon =
    verdict === "new" ? (
      <CheckCircle2 className={`size-3 ${iconClass}`} />
    ) : verdict === "suspicious" ? (
      <AlertTriangle className={`size-3 ${iconClass}`} />
    ) : (
      <XCircle className={`size-3 ${iconClass}`} />
    );

  return (
    <div className="rounded-xl border border-hairline overflow-hidden">
      <button
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium hover:bg-paper transition-colors"
        onClick={() => setOpen((o) => !o)}
        type="button"
      >
        <span className="flex items-center gap-2">
          {icon}
          <span className="capitalize text-ink">{verdict}</span>
          <Badge variant={color}>{rows.length}</Badge>
        </span>
        <span className="text-soft text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="divide-y divide-hairline text-xs">
          {rows.map((r) => (
            <div key={r.ordinal} className="flex items-baseline justify-between gap-2 px-3 py-1.5">
              <div className="flex-1 truncate">
                <span className="text-soft mr-2">{r.date}</span>
                <span className="text-ink">{r.description}</span>
                {verdict === "suspicious" && (
                  <span className="ml-2 text-warn-ink">
                    — balance discontinuity
                  </span>
                )}
              </div>
              <span className={`tnum shrink-0 font-medium ${cmp(r.amount, "0") < 0 ? "text-money-neg" : "text-money-pos"}`}>{formatINR(r.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main wizard ───────────────────────────────────────────────────────────────

export function ImportWizard({
  accounts,
  onDone,
}: {
  accounts: Account[];
  onDone: () => void;
}) {
  const [step, setStep] = useState<"upload" | "map" | "preview" | "done">("upload");
  const [accountId, setAccountId] = useState<string>("");
  const [filename, setFilename] = useState("");
  const [parseState, setParseState] = useState<ParseState | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>(blankMapping());
  const [stageState, setStageState] = useState<StageState | null>(null);
  const [isPending, startTransition] = useTransition();

  // ── Step 1: Upload ──

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !accountId) return;
    setFilename(file.name);

    const fd = new FormData();
    fd.append("file", file);
    fd.append("accountId", accountId);

    startTransition(async () => {
      try {
        const result = await parseUpload(fd);
        setParseState(result);
        // Pre-fill mapping from saved config or blank
        setMapping(
          result.savedMapping
            ? result.savedMapping
            : blankMapping(),
        );
        setStep("map");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Parse failed");
      }
    });
  }

  // ── Step 2: Map + Stage ──

  function handleMappingChange(role: MappingRole, value: string) {
    setMapping((m) => {
      const next = { ...m } as unknown as Record<string, unknown>;
      if (value === "__none__") {
        delete next[role];
      } else {
        next[role] = value;
      }
      return next as unknown as ColumnMapping;
    });
  }

  async function handleStage() {
    if (!parseState) return;
    startTransition(async () => {
      try {
        const result = await stageWithMapping({
          accountId,
          filename,
          mapping,
          headers: parseState.headers,
          rows: parseState.allRows,
        });
        // Fetch verdict preview rows
        const previewRows = await getImportRows(result.importId);
        setStageState({ ...result, previewRows });
        setStep("preview");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Staging failed");
      }
    });
  }

  // ── Step 3: Commit ──

  async function handleCommit() {
    if (!stageState) return;
    startTransition(async () => {
      try {
        const { created } = await commitImportAction(stageState.importId);
        toast.success(`${created} transaction${created !== 1 ? "s" : ""} imported — review them in Inbox`);
        setStep("done");
        onDone();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Commit failed");
      }
    });
  }

  // ── Render ──

  if (step === "upload") {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <label className="text-[10px] font-semibold uppercase tracking-[0.12em] text-soft">Account</label>
          <Select value={accountId} onValueChange={(v) => { if (v !== null) setAccountId(v); }}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select account…" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label className="text-[10px] font-semibold uppercase tracking-[0.12em] text-soft">Statement file</label>
          <label
            className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-hairline px-4 py-8 transition-colors hover:border-coral hover:bg-paper ${!accountId ? "pointer-events-none opacity-50" : ""}`}
          >
            <UploadCloud className="size-6 text-soft" />
            <span className="text-sm text-soft">
              {isPending ? "Parsing…" : "Click to upload .csv or .xlsx"}
            </span>
            <input
              type="file"
              accept=".csv,.xlsx"
              className="sr-only"
              disabled={!accountId || isPending}
              onChange={handleFileUpload}
            />
          </label>
        </div>
      </div>
    );
  }

  if (step === "map" && parseState) {
    const headers = parseState.headers;
    // Build preview: apply mapping to sampleRows for live feedback
    return (
      <div className="space-y-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-soft mb-2">Map columns</p>
          <div className="grid grid-cols-2 gap-2">
            {/* Date */}
            <div className="space-y-1">
              <label className="text-xs text-soft">Date *</label>
              <Select
                value={mapping.date ?? ""}
                onValueChange={(v) => { if (v !== null) handleMappingChange("date", v); }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick column…" />
                </SelectTrigger>
                <SelectContent>
                  {headers.map((h) => (
                    <SelectItem key={h} value={h}>
                      {h}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* Description */}
            <div className="space-y-1">
              <label className="text-xs text-soft">Description *</label>
              <Select
                value={mapping.description ?? ""}
                onValueChange={(v) => { if (v !== null) handleMappingChange("description", v); }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick column…" />
                </SelectTrigger>
                <SelectContent>
                  {headers.map((h) => (
                    <SelectItem key={h} value={h}>
                      {h}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* Optional roles */}
            {OPTIONAL_ROLES.map(({ key, label }) => (
              <div key={key} className="space-y-1">
                <label className="text-xs text-soft">{label}</label>
                <Select
                  value={(mapping as unknown as Record<string, string | undefined>)[key] ?? "__none__"}
                  onValueChange={(v) => { if (v !== null) handleMappingChange(key, v); }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="— none —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— none —</SelectItem>
                    {headers.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
            {/* Date format */}
            <div className="col-span-2 space-y-1">
              <label className="text-xs text-soft">Date format *</label>
              <Select
                value={mapping.dateFormat}
                onValueChange={(v) => {
                  if (v !== null) setMapping((m) => ({ ...m, dateFormat: v as DateFormat }));
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DATE_FORMATS.map((f) => (
                    <SelectItem key={f.value} value={f.value}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Preview table */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-soft mb-1">Preview — first 5 rows</p>
          <PreviewTable headers={parseState.headers} sampleRows={parseState.sampleRows} />
        </div>

        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setStep("upload")} disabled={isPending}>
            Back
          </Button>
          <Button
            onClick={handleStage}
            disabled={isPending || !mapping.date || !mapping.description}
            className="flex-1 bg-coral text-coral-text hover:bg-coral/90"
          >
            {isPending ? "Staging…" : "Stage import"}
          </Button>
        </div>
      </div>
    );
  }

  if (step === "preview" && stageState) {
    const { stats, previewRows, failed } = stageState;
    const newRows = previewRows.filter((r) => r.verdict === "new");
    const dupRows = previewRows.filter((r) => r.verdict === "duplicate");
    const suspRows = previewRows.filter((r) => r.verdict === "suspicious");

    return (
      <div className="space-y-4">
        {/* Stats chips */}
        <div className="flex flex-wrap gap-2">
          <Badge variant="default">{stats.new} new</Badge>
          <Badge variant="secondary">{stats.duplicates} duplicates</Badge>
          {stats.suspicious > 0 && (
            <Badge variant="destructive">{stats.suspicious} suspicious</Badge>
          )}
          {failed.length > 0 && (
            <Badge variant="destructive">{failed.length} parse errors</Badge>
          )}
        </div>

        {/* Expandable sections */}
        <div className="space-y-2">
          <VerdictSection verdict="new" rows={newRows} />
          <VerdictSection verdict="suspicious" rows={suspRows} />
          <VerdictSection verdict="duplicate" rows={dupRows} />
        </div>

        {/* Parse failures */}
        {failed.length > 0 && (
          <div className="rounded-xl border border-money-neg/30 bg-neg-bg px-3 py-2 text-xs text-money-neg">
            <p className="font-semibold mb-1">Rows skipped during mapping:</p>
            {failed.map((f) => (
              <p key={f.ordinal}>
                Row {f.ordinal + 1}: {f.reason}
              </p>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setStep("map")}
            disabled={isPending}
          >
            Back
          </Button>
          <Button
            onClick={handleCommit}
            disabled={isPending || stats.new === 0}
            className="flex-1 bg-coral text-coral-text hover:bg-coral/90 disabled:opacity-50"
          >
            {isPending
              ? "Committing…"
              : `Import ${stats.new} transaction${stats.new !== 1 ? "s" : ""}`}
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
