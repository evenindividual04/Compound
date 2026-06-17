import { describe, it, expect } from "vitest";
import { classifyWithLlm } from "./llm";

const cats = [{ id: "c1", name: "Food & Dining" }, { id: "c2", name: "Groceries" }];

describe("classifyWithLlm", () => {
  it("maps an in-list name to its id", async () => {
    const r = await classifyWithLlm(
      { text: "Zomato", amount: "-642.0000", categories: cats },
      { generate: async () => ({ name: "Food & Dining", confidence: 0.95 }) },
    );
    expect(r).toEqual({ categoryId: "c1", confidence: 0.95 });
  });
  it("abstains on UNSURE / out-of-list / null", async () => {
    expect(await classifyWithLlm({ text: "Zomato", amount: "-1", categories: cats }, { generate: async () => null })).toBeNull();
    expect(await classifyWithLlm({ text: "Zomato", amount: "-1", categories: cats }, { generate: async () => ({ name: "Travel", confidence: 0.9 }) })).toBeNull();
  });
  it("fails closed when redaction strips everything", async () => {
    let called = false;
    const r = await classifyWithLlm({ text: "987654321098", amount: "-1", categories: cats }, { generate: async () => { called = true; return { name: "Food & Dining", confidence: 1 }; } });
    expect(r).toBeNull();
    expect(called).toBe(false); // never called the model with unredactable text
  });
});
