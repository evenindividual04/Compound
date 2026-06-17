"use server";

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { requireHousehold } from "@/lib/current";
import { createTrade } from "@/lib/invest/trade";
import { afterWrite } from "@/lib/ledger/derive";

// units/price are NUMERIC strings end-to-end — never Number() a money value (AGENTS.md).
const PositiveDecimal = z.string().regex(/^\d+(\.\d+)?$/, "Must be a positive number");

const NewInstrumentSchema = z.object({
  kind: z.enum(["mf", "equity"]),
  name: z.string().min(1).max(255),
  symbol: z.string().max(64).optional(),
  isin: z.string().max(32).optional(),
  amfiCode: z.string().max(32).optional(),
});

const CreateTradeSchema = z
  .object({
    accountId: z.string().uuid(),
    instrumentId: z.string().uuid().optional(),
    newInstrument: NewInstrumentSchema.optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
    side: z.enum(["buy", "sell"]),
    units: PositiveDecimal,
    price: PositiveDecimal,
  })
  .refine((v) => Boolean(v.instrumentId) !== Boolean(v.newInstrument), {
    message: "Provide either an existing instrument or a new one, not both",
  })
  .refine(
    (v) =>
      !v.newInstrument ||
      (v.newInstrument.kind === "mf"
        ? Boolean(v.newInstrument.amfiCode)
        : Boolean(v.newInstrument.symbol)),
    { message: "New mutual funds need an AMFI code; equities need a symbol" },
  );

type NewInstrumentInput = z.infer<typeof NewInstrumentSchema>;

/**
 * Resolve the instrument for a manual trade. For a new instrument we mirror
 * pipeline.ts resolveOrCreateInstrument: insert with onConflictDoNothing, then
 * re-select on an empty return so a concurrent insert of the same identifier
 * resolves to one row. For an existing instrumentId we verify household ownership.
 */
async function resolveInstrument(
  householdId: string,
  instrumentId: string | undefined,
  newInstrument: NewInstrumentInput | undefined,
): Promise<string> {
  if (instrumentId) {
    const [owned] = await db
      .select({ id: schema.instruments.id })
      .from(schema.instruments)
      .where(
        and(
          eq(schema.instruments.id, instrumentId),
          eq(schema.instruments.householdId, householdId),
        ),
      );
    if (!owned) throw new Error("instrument not found or unauthorized");
    return owned.id;
  }

  const ni = newInstrument!;
  const symbol = ni.kind === "equity" ? (ni.symbol ?? null) : null;
  const amfiCode = ni.kind === "mf" ? (ni.amfiCode ?? null) : null;
  const isin = ni.isin || null;

  // The identifier the unique index will key on (matches the has-identifier check).
  const idColumn = ni.kind === "mf" ? schema.instruments.amfiCode : schema.instruments.symbol;
  const idValue = ni.kind === "mf" ? amfiCode! : symbol!;

  const lookup = () =>
    db
      .select({ id: schema.instruments.id })
      .from(schema.instruments)
      .where(
        and(eq(schema.instruments.householdId, householdId), eq(idColumn, idValue)),
      );

  const [existing] = await lookup();
  if (existing) return existing.id;

  const [created] = await db
    .insert(schema.instruments)
    .values({ householdId, kind: ni.kind, name: ni.name, symbol, isin, amfiCode })
    .onConflictDoNothing()
    .returning({ id: schema.instruments.id });
  if (created) return created.id;

  const [raced] = await lookup();
  if (!raced) throw new Error("instrument upsert failed: no row after conflict");
  return raced.id;
}

export async function createTradeAction(
  raw: unknown,
): Promise<{ ok: true; entryId: string } | { ok: false; error: string }> {
  try {
    const { householdId } = await requireHousehold();
    const input = CreateTradeSchema.parse(raw);

    // Verify the account is an investment account owned by this household.
    const [account] = await db
      .select({ id: schema.accounts.id, kind: schema.accounts.kind })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.id, input.accountId),
          eq(schema.accounts.householdId, householdId),
        ),
      );
    if (!account) throw new Error("account not found or unauthorized");
    if (account.kind !== "investment") throw new Error("trades require an investment account");

    const instrumentId = await resolveInstrument(
      householdId,
      input.instrumentId,
      input.newInstrument,
    );

    // Manual entries post immediately (consistent with quick-add); imports stay pending.
    const entryId = await createTrade(db, {
      accountId: input.accountId,
      instrumentId,
      date: input.date,
      side: input.side,
      units: input.units,
      price: input.price,
      status: "posted",
      source: "manual",
    });

    await afterWrite(db, { accountId: input.accountId, householdId, date: input.date });

    revalidatePath("/");
    revalidatePath("/transactions");
    revalidatePath("/invest");

    return { ok: true, entryId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
