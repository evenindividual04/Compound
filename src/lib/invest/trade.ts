/**
 * The only way `trade` entries enter the ledger (mirrors lib/ledger/write.ts).
 * entries.amount carries the signed CASH value of the trade: buy → −(units×price),
 * sell → +(units×price) (ADR-1). Units/price live in the trades subtype.
 * Money stays in the string domain — cash value at 4dp via lib/money.ts.
 */
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { mul, neg, cmp } from "@/lib/money";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export interface NewTrade {
  accountId: string;
  instrumentId: string;
  date: string;
  side: "buy" | "sell";
  units: string;
  price: string;
  description?: string;
  status?: "pending" | "posted";
  source?: "manual" | "import" | "system";
  importId?: string | null;
  importHash?: string | null;
  externalId?: string | null;
}

/** Cash value of the trade, 4dp, signed by side. */
export function tradeCashAmount(side: "buy" | "sell", units: string, price: string): string {
  const gross = mul(units, price);
  return side === "buy" ? neg(gross) : gross;
}

export async function createTrade(db: Db, input: NewTrade): Promise<string> {
  if (cmp(input.units, "0") <= 0) throw new Error("units must be positive");
  if (cmp(input.price, "0") <= 0) throw new Error("price must be positive");
  const amount = tradeCashAmount(input.side, input.units, input.price);
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(schema.entries)
      .values({
        accountId: input.accountId,
        entryType: "trade",
        date: input.date,
        amount,
        description: input.description ?? "",
        status: input.status ?? "posted",
        source: input.source ?? "manual",
        importId: input.importId ?? null,
        importHash: input.importHash ?? null,
        externalId: input.externalId ?? null,
      })
      .returning();
    await tx.insert(schema.trades).values({
      entryId: entry.id,
      instrumentId: input.instrumentId,
      side: input.side,
      units: input.units,
      price: input.price,
    });
    await tx
      .insert(schema.entryEvents)
      .values({ entryId: entry.id, field: "created", oldValue: null, newValue: amount, source: input.source ?? "manual" });
    return entry.id;
  });
}
