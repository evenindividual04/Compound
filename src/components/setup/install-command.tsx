"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

interface InstallCommandProps {
  origin: string;
  secret: string;
}

export function InstallCommand({ origin, secret }: InstallCommandProps) {
  const [revealed, setRevealed] = useState(false);
  const command = `curl -fsSL ${origin}/bridge/install.sh | INGEST_URL=${origin} INGEST_SECRET=${secret} bash`;
  const displayCommand = revealed
    ? command
    : command.replace(secret, "•".repeat(12));

  async function handleCopy() {
    await navigator.clipboard.writeText(command);
  }

  return (
    <div className="rounded-xl bg-paper border border-hairline p-3">
      <pre className="text-xs text-ink overflow-x-auto whitespace-pre-wrap break-all">
        {displayCommand}
      </pre>
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setRevealed((r) => !r)}>
          {revealed ? "Hide secret" : "Reveal secret"}
        </Button>
        <Button size="sm" onClick={handleCopy}>
          Copy command
        </Button>
      </div>
    </div>
  );
}
