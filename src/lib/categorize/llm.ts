import { redactForLlm } from "./redact";
import { amountBucket } from "./bucket";

export type GenerateFn = (prompt: string, categoryNames: string[]) => Promise<{ name: string; confidence: number } | null>;

export interface LlmInput {
  text: string;
  amount: string;
  categories: { id: string; name: string }[];
}

export async function classifyWithLlm(
  input: LlmInput,
  deps: { generate: GenerateFn },
): Promise<{ categoryId: string; confidence: number } | null> {
  const safe = redactForLlm(input.text);
  if (!safe) return null; // fail closed (spec §6)
  const names = input.categories.map((c) => c.name);
  const prompt =
    `Merchant: ${safe}\nAmount: ${amountBucket(input.amount)}\n` +
    `Pick exactly one category from the list, or answer UNSURE. Categories: ${names.join(", ")}`;
  const out = await deps.generate(prompt, names);
  if (!out) return null;
  const match = input.categories.find((c) => c.name === out.name);
  if (!match) return null; // out-of-list → abstain
  return { categoryId: match.id, confidence: out.confidence };
}
