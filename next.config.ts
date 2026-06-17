import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // fastembed loads a native (non-ESM) tokenizer addon; it must be required at
  // runtime in the Node server, never bundled by Turbopack (which can't place a
  // native asset in an ESM chunk). The embedder only ever runs server-side.
  serverExternalPackages: ["fastembed", "@anush008/tokenizers"],
};

export default nextConfig;
