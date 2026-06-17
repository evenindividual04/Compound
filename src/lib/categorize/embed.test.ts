import { describe, it, expect } from "vitest";
import { embed } from "./embed";
describe("embed", () => {
  it("returns a 384-d vector and is stable for the same input", async () => {
    const a = await embed("zomato");
    const b = await embed("zomato");
    expect(a).toHaveLength(384);
    expect(a[0]).toBeCloseTo(b[0], 6);
  }, 60_000);
});
