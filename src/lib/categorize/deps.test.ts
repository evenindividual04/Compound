/**
 * Shape/wiring tests for defaultCategorizeDeps().
 * These tests MUST NOT call a live model or network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the `ai` module so generateObject never fires a real network call.
vi.mock("ai", () => ({
  gateway: vi.fn((modelId: string) => ({ _modelId: modelId })),
  generateObject: vi.fn(),
}));

// Mock the local embedder so no fastembed model is loaded.
vi.mock("./embed", () => ({
  embed: vi.fn(async () => new Array(384).fill(0)),
}));

import { defaultCategorizeDeps } from "./deps";
import { gateway, generateObject } from "ai";

describe("defaultCategorizeDeps", () => {
  it("returns an object with embed and generate functions", () => {
    const deps = defaultCategorizeDeps();
    expect(typeof deps.embed).toBe("function");
    expect(typeof deps.generate).toBe("function");
  });

  it("generate returns null without throwing if generateObject rejects", async () => {
    vi.mocked(generateObject).mockRejectedValueOnce(new Error("network error"));
    const deps = defaultCategorizeDeps();
    const result = await deps.generate("some prompt", ["Food", "Transport"]);
    expect(result).toBeNull();
  });

  it("generate returns null when the model returns UNSURE", async () => {
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: { category: "UNSURE", confidence: 0.5 },
    } as never);
    const deps = defaultCategorizeDeps();
    const result = await deps.generate("some prompt", ["Food", "Transport"]);
    expect(result).toBeNull();
  });

  it("generate returns { name, confidence } for a known category", async () => {
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: { category: "Food", confidence: 0.9 },
    } as never);
    const deps = defaultCategorizeDeps();
    const result = await deps.generate("some prompt", ["Food", "Transport"]);
    expect(result).toEqual({ name: "Food", confidence: 0.9 });
  });

  describe("CATEGORIZER_MODEL env var", () => {
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env.CATEGORIZER_MODEL;
      vi.mocked(gateway).mockClear();
    });

    afterEach(() => {
      if (saved === undefined) {
        delete process.env.CATEGORIZER_MODEL;
      } else {
        process.env.CATEGORIZER_MODEL = saved;
      }
    });

    it("defaults to anthropic/claude-haiku-4-5 when env is unset", async () => {
      delete process.env.CATEGORIZER_MODEL;
      vi.mocked(generateObject).mockResolvedValueOnce({
        object: { category: "Food", confidence: 0.8 },
      } as never);
      await defaultCategorizeDeps().generate("prompt", ["Food"]);
      expect(vi.mocked(gateway)).toHaveBeenCalledWith("anthropic/claude-haiku-4-5");
    });

    it("uses CATEGORIZER_MODEL when set", async () => {
      process.env.CATEGORIZER_MODEL = "openai/gpt-4o-mini";
      vi.mocked(generateObject).mockResolvedValueOnce({
        object: { category: "Food", confidence: 0.8 },
      } as never);
      await defaultCategorizeDeps().generate("prompt", ["Food"]);
      expect(vi.mocked(gateway)).toHaveBeenCalledWith("openai/gpt-4o-mini");
    });
  });
});
