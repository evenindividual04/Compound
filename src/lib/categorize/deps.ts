/**
 * Production deps for the categorizer: local embedder (T1) + AI Gateway generate (T2).
 * Model is configurable via CATEGORIZER_MODEL env var; defaults to anthropic/claude-haiku-4-5.
 * Auth for the AI Gateway uses AI_GATEWAY_API_KEY or Vercel OIDC — no key needed in local dev
 * when calls are mocked.
 */
import { generateObject, gateway } from "ai";
import type { GatewayModelId } from "ai";
import { z } from "zod";
import { embed } from "./embed";
import type { CategorizeDeps } from "./categorize";
import type { GenerateFn } from "./llm";

export function defaultCategorizeDeps(): CategorizeDeps {
  const modelId: GatewayModelId =
    (process.env.CATEGORIZER_MODEL ?? "anthropic/claude-haiku-4-5") as GatewayModelId;

  const generate: GenerateFn = async (prompt, names) => {
    const schema = z.object({
      category: z.enum([...names, "UNSURE"] as unknown as [string, ...string[]]),
      confidence: z.number().min(0).max(1),
    });
    try {
      const { object } = await generateObject({ model: gateway(modelId), schema, prompt });
      if (object.category === "UNSURE") return null;
      return { name: object.category, confidence: object.confidence };
    } catch {
      return null; // LLM failure → abstain, never throw into ingestion
    }
  };

  return { embed, generate };
}
