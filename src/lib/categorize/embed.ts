import { FlagEmbedding, EmbeddingModel } from "fastembed";

export type Embedder = (text: string) => Promise<number[]>;

let modelP: Promise<FlagEmbedding> | null = null;
function model(): Promise<FlagEmbedding> {
  modelP ??= FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15 });
  return modelP;
}

/** Local sentence embedding (384-d). Never calls a cloud API. */
export const embed: Embedder = async (text) => {
  const m = await model();
  const raw = await m.queryEmbed(text || " ");
  // fastembed returns a Float32Array; convert to a plain number[] as the Embedder contract requires.
  return Array.from(raw);
};
