import { NextResponse } from "next/server";
import { db } from "@/db";
import { runInvariantChecks } from "@/lib/ledger/invariants";

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const counts = await runInvariantChecks(db);
  return NextResponse.json({ ok: true, counts });
}
