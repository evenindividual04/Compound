import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "@/lib/ledger/test-db";
import * as schema from "@/db/schema";

describe.skipIf(!process.env.TEST_DATABASE_URL)("p2 schema", () => {
  beforeEach(resetDb);

  it("inserts an instrument and round-trips numeric strings", async () => {
    const { hh } = await seedBasics();
    const [inst] = await tdb
      .insert(schema.instruments)
      .values({ householdId: hh.id, kind: "mf", name: "Parag Parikh Flexi Cap", amfiCode: "122639" })
      .returning();
    expect(inst.kind).toBe("mf");
    expect(inst.amfiCode).toBe("122639");
  });
});
