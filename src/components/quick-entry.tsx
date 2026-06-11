"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { formatINR } from "@/lib/money";
import { todayIST, yesterdayIST } from "@/lib/dates";
import { enqueue, replay } from "@/lib/outbox";
import type { OutboxPayload } from "@/lib/outbox";
import { quickAddAction } from "@/app/actions/entries";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export interface CategoryOption {
  id: string;
  name: string;
  classification: "income" | "expense";
  parentName: string | null;
}

export interface AccountOption {
  id: string;
  name: string;
}

interface QuickEntryProps {
  categories: CategoryOption[];
  recentIds: string[];
  accounts: AccountOption[];
}

const LS_LAST_ACCOUNT = "fin:last-account";

const KEYPAD = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  [".", "0", "⌫"],
] as const;

function useLastAccount(accounts: AccountOption[]) {
  const [accountId, setAccountId] = useState<string>(() => {
    if (typeof window === "undefined") return accounts[0]?.id ?? "";
    return localStorage.getItem(LS_LAST_ACCOUNT) ?? accounts[0]?.id ?? "";
  });

  function setAndPersist(id: string) {
    setAccountId(id);
    try {
      localStorage.setItem(LS_LAST_ACCOUNT, id);
    } catch {
      // ignore
    }
  }

  return [accountId, setAndPersist] as const;
}

export function QuickEntry({ categories, recentIds, accounts }: QuickEntryProps) {
  const [open, setOpen] = useState(false);
  const [display, setDisplay] = useState("0");
  const [date, setDate] = useState<string>(todayIST());
  const [description, setDescription] = useState("");
  const [showDesc, setShowDesc] = useState(false);
  const [accountId, setAccountId] = useLastAccount(accounts);
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

  // Reset idempotency key each time the drawer opens
  useEffect(() => {
    if (open) {
      idempotencyKeyRef.current = crypto.randomUUID();
      setDisplay("0");
      setDescription("");
      setShowDesc(false);
      setDate(todayIST());
    }
  }, [open]);

  // Replay outbox on mount and when coming back online
  useEffect(() => {
    const sendPayload = async (p: OutboxPayload) => {
      const res = await quickAddAction(p);
      if (!res.ok) throw new Error(res.error);
    };

    replay(sendPayload).catch(() => {});

    const handleOnline = () => {
      replay(sendPayload).catch(() => {});
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  function handleKey(key: string) {
    setDisplay((prev) => {
      if (key === "⌫") {
        const next = prev.slice(0, -1) || "0";
        return next;
      }
      if (key === ".") {
        if (prev.includes(".")) return prev;
        return prev + ".";
      }
      if (prev === "0") return key;
      // Limit to 2 decimal places
      const dotIdx = prev.indexOf(".");
      if (dotIdx !== -1 && prev.length - dotIdx > 2) return prev;
      return prev + key;
    });
  }

  async function submit(categoryId: string) {
    const amountAbs = parseFloat(display);
    if (!amountAbs || amountAbs <= 0) {
      toast.error("Enter an amount first");
      return;
    }

    if (!accountId) {
      toast.error("Select an account");
      return;
    }

    const payload: OutboxPayload = {
      idempotencyKey: idempotencyKeyRef.current,
      accountId,
      categoryId,
      amountAbs: display,
      date,
      description: description || undefined,
    };

    // Optimistic close + toast
    setOpen(false);
    const toastId = toast.loading("Saving…");

    try {
      const res = await quickAddAction(payload);
      if (!res.ok) {
        toast.error(res.error, { id: toastId });
        setOpen(true);
        return;
      }
      toast.success(res.deduped ? "Already saved" : "Saved", { id: toastId });
    } catch (err) {
      // Network failure → outbox
      if (err instanceof TypeError) {
        await enqueue(payload);
        toast.info("Saved offline — will sync when online", { id: toastId });
      } else {
        toast.error(err instanceof Error ? err.message : "Failed to save", { id: toastId });
        setOpen(true);
      }
    }
  }

  const recentCategories = recentIds
    .map((id) => categories.find((c) => c.id === id))
    .filter(Boolean) as CategoryOption[];

  // Group categories by parent for the "More" Select
  const grouped = categories.reduce<Record<string, CategoryOption[]>>((acc, cat) => {
    const group = cat.parentName ?? "Other";
    if (!acc[group]) acc[group] = [];
    acc[group].push(cat);
    return acc;
  }, {});

  const today = todayIST();
  const yesterday = yesterdayIST();

  return (
    <>
      {/* FAB */}
      <button
        id="quick-entry-fab"
        aria-label="Quick entry"
        onClick={() => setOpen(true)}
        className="fixed bottom-20 left-1/2 z-50 flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-full bg-primary text-2xl font-light text-primary-foreground shadow-lg transition-transform hover:scale-105 active:scale-95"
        style={{ marginBottom: "env(safe-area-inset-bottom)" }}
      >
        +
      </button>

      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent className="px-4 pb-6">
          <DrawerHeader className="pb-2">
            <DrawerTitle>Quick Entry</DrawerTitle>
          </DrawerHeader>

          {/* Amount display */}
          <div className="tnum flex items-baseline justify-center pb-4 text-5xl font-semibold tracking-tight">
            {formatINR(display === "" || display === "0" ? "0" : display)}
          </div>

          {/* Keypad */}
          <div className="mx-auto mb-4 grid w-full max-w-xs grid-cols-3 gap-2">
            {KEYPAD.flat().map((key) => (
              <button
                key={key}
                onClick={() => handleKey(key)}
                className="tnum flex h-12 items-center justify-center rounded-xl bg-secondary text-lg font-medium text-secondary-foreground transition-colors active:bg-secondary/70"
              >
                {key}
              </button>
            ))}
          </div>

          {/* Recent category chips */}
          {recentCategories.length > 0 && (
            <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
              {recentCategories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => submit(cat.id)}
                  className="shrink-0 rounded-full border border-border bg-secondary px-3 py-1.5 text-sm font-medium text-secondary-foreground transition-colors active:bg-secondary/70"
                >
                  {cat.name}
                </button>
              ))}
            </div>
          )}

          {/* Controls row: More category select, account, date chips, description toggle */}
          <div className="flex flex-wrap items-center gap-2">
            {/* "More" category select */}
            <Select
              onValueChange={(id) => {
                if (id != null) void submit(id as string);
              }}
            >
              <SelectTrigger size="sm" className="w-auto">
                <SelectValue placeholder="More…" />
                <ChevronDownIcon className="ml-1 h-3 w-3 text-muted-foreground" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(grouped).map(([group, cats]) => (
                  <SelectGroup key={group}>
                    <SelectLabel>{group}</SelectLabel>
                    {cats.map((cat) => (
                      <SelectItem key={cat.id} value={cat.id}>
                        <span className="flex items-center gap-2">
                          {cat.name}
                          <Badge
                            variant="outline"
                            className="text-[10px]"
                          >
                            {cat.classification === "income" ? "+" : "−"}
                          </Badge>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>

            {/* Account select */}
            {accounts.length > 0 && (
              <Select value={accountId} onValueChange={(v) => { if (v != null) setAccountId(v as string); }}>
                <SelectTrigger size="sm" className="w-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Date chips */}
            <button
              onClick={() => setDate(today)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                date === today
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              Today
            </button>
            <button
              onClick={() => setDate(yesterday)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                date === yesterday
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              Yesterday
            </button>

            {/* Description toggle */}
            <button
              onClick={() => setShowDesc((v) => !v)}
              aria-label="Add note"
              className="rounded-lg border border-border p-1.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Optional description */}
          {showDesc && (
            <Input
              className="mt-3"
              placeholder="Note (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={255}
            />
          )}
        </DrawerContent>
      </Drawer>
    </>
  );
}
