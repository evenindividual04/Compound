"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { formatINR, mul, cmp } from "@/lib/money";
import { todayIST } from "@/lib/dates";
import { createTradeAction } from "@/app/actions/trades";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerFooter,
} from "@/components/ui/drawer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export interface InvestAccountOption {
  id: string;
  name: string;
}

export interface InstrumentOption {
  id: string;
  name: string;
  kind: "mf" | "equity";
}

interface TradeFormProps {
  accounts: InvestAccountOption[];
  instruments: InstrumentOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ADD_NEW = "__add_new__";
const DECIMAL = /^\d*(\.\d*)?$/;

/** Coerce a permissive input value (".5", "5.", "") to the server's strict form ("0.5", "5", ""). */
function normalizeDecimal(v: string): string {
  if (v === "" || v === ".") return "";
  let n = v.startsWith(".") ? `0${v}` : v;
  if (n.endsWith(".")) n = n.slice(0, -1);
  return n;
}

const labelClass =
  "text-[0.8125rem] font-medium uppercase tracking-wide text-soft";

export function TradeForm({ accounts, instruments, open, onOpenChange }: TradeFormProps) {
  const [accountId, setAccountId] = useState("");
  const [instrumentId, setInstrumentId] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [units, setUnits] = useState("");
  const [price, setPrice] = useState("");
  const [date, setDate] = useState(todayIST());

  // "Add new" instrument fields
  const [newKind, setNewKind] = useState<"mf" | "equity">("mf");
  const [newName, setNewName] = useState("");
  const [newIdentifier, setNewIdentifier] = useState(""); // amfiCode (mf) | symbol (equity)
  const [newIsin, setNewIsin] = useState("");

  const [submitting, setSubmitting] = useState(false);

  const addingNew = instrumentId === ADD_NEW;

  useEffect(() => {
    if (open) {
      setAccountId(accounts[0]?.id ?? "");
      setInstrumentId("");
      setSide("buy");
      setUnits("");
      setPrice("");
      setDate(todayIST());
      setNewKind("mf");
      setNewName("");
      setNewIdentifier("");
      setNewIsin("");
    }
  }, [open, accounts]);

  // Live cash value: units × price, computed in the string domain (never Number()).
  const cashPreview = useMemo(() => {
    const u = normalizeDecimal(units);
    const p = normalizeDecimal(price);
    if (!u || !p) return null;
    return mul(u, p);
  }, [units, price]);

  function handleDecimal(setter: (v: string) => void) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      if (v === "" || DECIMAL.test(v)) setter(v);
    };
  }

  async function submit() {
    if (!accountId) {
      toast.error("Pick an account");
      return;
    }
    if (!instrumentId) {
      toast.error("Pick an instrument");
      return;
    }
    // Normalize ".5" → "0.5" and strip a trailing dot so the value matches the
    // server's strict PositiveDecimal regex (form input is more permissive).
    const normUnits = normalizeDecimal(units);
    const normPrice = normalizeDecimal(price);
    if (!units || cmp(normUnits, "0") <= 0) {
      toast.error("Enter units");
      return;
    }
    if (!price || cmp(normPrice, "0") <= 0) {
      toast.error("Enter a price");
      return;
    }

    const base = { accountId, date, side, units: normUnits, price: normPrice };
    let payload: Record<string, unknown>;

    if (addingNew) {
      if (!newName.trim()) {
        toast.error("Name the instrument");
        return;
      }
      if (!newIdentifier.trim()) {
        toast.error(newKind === "mf" ? "Enter the AMFI code" : "Enter the symbol");
        return;
      }
      payload = {
        ...base,
        newInstrument: {
          kind: newKind,
          name: newName.trim(),
          symbol: newKind === "equity" ? newIdentifier.trim() : undefined,
          amfiCode: newKind === "mf" ? newIdentifier.trim() : undefined,
          isin: newIsin.trim() || undefined,
        },
      };
    } else {
      payload = { ...base, instrumentId };
    }

    setSubmitting(true);
    const toastId = toast.loading("Recording trade…");
    try {
      const res = await createTradeAction(payload);
      if (!res.ok) {
        toast.error(res.error, { id: toastId });
        return;
      }
      toast.success("Trade recorded", { id: toastId });
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to record trade", { id: toastId });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="px-4 pb-2">
        <DrawerHeader className="px-0 pb-2">
          <DrawerTitle>Record trade</DrawerTitle>
          <DrawerDescription>A manual buy or sell. Posts immediately.</DrawerDescription>
        </DrawerHeader>

        <div className="flex flex-col gap-4">
          {/* Account */}
          <div className="flex flex-col gap-1.5">
            <span className={labelClass}>Account</span>
            <Select value={accountId} onValueChange={(v) => v != null && setAccountId(v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Investment account" />
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

          {/* Instrument */}
          <div className="flex flex-col gap-1.5">
            <span className={labelClass}>Instrument</span>
            <Select value={instrumentId} onValueChange={(v) => v != null && setInstrumentId(v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pick or add an instrument" />
              </SelectTrigger>
              <SelectContent>
                {instruments.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.name}
                  </SelectItem>
                ))}
                <SelectItem value={ADD_NEW}>+ Add new</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Add-new instrument fields */}
          {addingNew && (
            <div className="flex flex-col gap-3 rounded-xl border border-hairline p-3">
              <div className="flex gap-2">
                {(["mf", "equity"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setNewKind(k)}
                    className={`flex-1 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                      newKind === k
                        ? "border-ink bg-ink text-surface"
                        : "border-hairline text-soft"
                    }`}
                  >
                    {k === "mf" ? "Mutual fund" : "Equity"}
                  </button>
                ))}
              </div>
              <Input
                placeholder="Name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={255}
              />
              <Input
                placeholder={newKind === "mf" ? "AMFI code" : "Symbol (e.g. INFY)"}
                value={newIdentifier}
                onChange={(e) => setNewIdentifier(e.target.value)}
                maxLength={64}
              />
              <Input
                placeholder="ISIN (optional)"
                value={newIsin}
                onChange={(e) => setNewIsin(e.target.value)}
                maxLength={32}
              />
            </div>
          )}

          {/* Side */}
          <div className="flex flex-col gap-1.5">
            <span className={labelClass}>Side</span>
            <div className="flex gap-2">
              {(["buy", "sell"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium capitalize transition-colors ${
                    side === s
                      ? "border-ink bg-ink text-surface"
                      : "border-hairline text-soft"
                  }`}
                  aria-pressed={side === s}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Units + Price */}
          <div className="flex gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <span className={labelClass}>Units</span>
              <Input
                className="tnum"
                inputMode="decimal"
                placeholder="0"
                value={units}
                onChange={handleDecimal(setUnits)}
              />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <span className={labelClass}>Price</span>
              <Input
                className="tnum"
                inputMode="decimal"
                placeholder="0"
                value={price}
                onChange={handleDecimal(setPrice)}
              />
            </div>
          </div>

          {/* Date */}
          <div className="flex flex-col gap-1.5">
            <span className={labelClass}>Date</span>
            <Input
              className="tnum"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          {/* Live cash value preview */}
          <div className="flex items-baseline justify-between border-t border-hairline pt-3">
            <span className={labelClass}>{side === "buy" ? "Cash out" : "Cash in"}</span>
            <span className="tnum text-lg font-semibold">
              {cashPreview ? formatINR(cashPreview) : "—"}
            </span>
          </div>
        </div>

        <DrawerFooter className="px-0">
          <Button onClick={submit} disabled={submitting} size="lg">
            {submitting ? "Recording…" : "Record trade"}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
