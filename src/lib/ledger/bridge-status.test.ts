import { describe, it, expect, beforeEach } from "vitest";
import { tdb, resetDb, seedBasics } from "./test-db";
import * as schema from "@/db/schema";
import { getBridgeStatus } from "./bridge-status";

describe.skipIf(!process.env.TEST_DATABASE_URL)("getBridgeStatus", () => {
  let seeds: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    await resetDb();
    seeds = await seedBasics();
  });

  it("returns 'never' when no heartbeat row exists", async () => {
    const result = await getBridgeStatus(tdb, seeds.hh.id);
    expect(result.status).toBe("never");
    expect(result.lastSeenAt).toBeNull();
  });

  it("returns 'ok' when the heartbeat is recent", async () => {
    await tdb.insert(schema.bridgeHeartbeats).values({
      householdId: seeds.hh.id,
      lastSeenAt: new Date(),
    });
    const result = await getBridgeStatus(tdb, seeds.hh.id);
    expect(result.status).toBe("ok");
    expect(result.lastSeenAt).not.toBeNull();
  });

  it("returns 'stale' when the heartbeat is older than 10 minutes", async () => {
    await tdb.insert(schema.bridgeHeartbeats).values({
      householdId: seeds.hh.id,
      lastSeenAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    const result = await getBridgeStatus(tdb, seeds.hh.id);
    expect(result.status).toBe("stale");
  });
});
