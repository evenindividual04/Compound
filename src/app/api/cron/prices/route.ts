import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { eq, and, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { parseAmfiNav } from "@/lib/invest/amfi";
import { upsertPrices, type PriceRow } from "@/lib/invest/price";

function authorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const AMFI_URL = "https://www.amfiindia.com/spages/NAVAll.txt";

export async function GET(req: Request) {
  if (!authorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const mfInstruments = await db
    .select({ id: schema.instruments.id, amfiCode: schema.instruments.amfiCode })
    .from(schema.instruments)
    .where(and(eq(schema.instruments.kind, "mf"), isNotNull(schema.instruments.amfiCode)));

  let mfUpdated = 0;
  if (mfInstruments.length) {
    try {
      const text = await fetch(AMFI_URL, { cache: "no-store" }).then((r) => r.text());
      const navs = parseAmfiNav(text);
      const rows: PriceRow[] = [];
      for (const inst of mfInstruments) {
        const nav = inst.amfiCode ? navs.get(inst.amfiCode) : undefined;
        if (nav) rows.push({ instrumentId: inst.id, date: nav.date, nav: nav.nav });
      }
      if (rows.length) await upsertPrices(db, rows);
      mfUpdated = rows.length;
    } catch {
      // best-effort: leave prices as-is, valuation falls back to last known (§6)
    }
  }

  // Equity: best-effort. Concrete source chosen later; on miss, write nothing (§5 fallback).
  const equityUpdated = 0;

  return NextResponse.json({ ok: true, mfUpdated, equityUpdated });
}
