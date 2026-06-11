"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyLastMonthAction } from "@/app/actions/budgets";

export function CopyLastMonthButton({ month }: { month: string }) {
  const [pending, startTransition] = useTransition();

  function handleCopy() {
    startTransition(async () => {
      const res = await copyLastMonthAction(month);
      if (res.ok) {
        if (res.copied === 0) {
          toast.info("No allocations to copy from last month");
        } else {
          toast.success(`Copied ${res.copied} budget${res.copied === 1 ? "" : "s"} from last month`);
        }
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={handleCopy} disabled={pending}>
      <Copy className="mr-1.5 h-3.5 w-3.5" />
      Copy last month
    </Button>
  );
}
