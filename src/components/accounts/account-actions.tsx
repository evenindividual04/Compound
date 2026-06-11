"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { closeAccount, setExcluded } from "@/app/actions/accounts";

interface Props {
  accountId: string;
  excluded: boolean;
  status: string;
}

export function AccountActions({ accountId, excluded, status }: Props) {
  const router = useRouter();
  const [isPendingExclude, startExclude] = useTransition();
  const [isPendingClose, startClose] = useTransition();
  const [closeOpen, setCloseOpen] = useState(false);

  function handleToggleExclude() {
    startExclude(async () => {
      try {
        await setExcluded(accountId, !excluded);
        toast.success(excluded ? "Account included in net worth" : "Account excluded from net worth");
      } catch {
        toast.error("Failed to update account");
      }
    });
  }

  function handleClose() {
    startClose(async () => {
      try {
        await closeAccount(accountId);
        toast.success("Account closed");
        setCloseOpen(false);
        router.push("/accounts");
      } catch {
        toast.error("Failed to close account");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="outline"
        onClick={handleToggleExclude}
        disabled={isPendingExclude}
      >
        {excluded ? "Include in net worth" : "Exclude from net worth"}
      </Button>

      {status === "active" && (
        <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
          <DialogTrigger
            render={<Button variant="destructive" />}
          >
            Close account
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Close account?</DialogTitle>
              <DialogDescription>
                The account will be marked closed and hidden from net worth calculations.
                This cannot be undone from the UI.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter showCloseButton>
              <Button
                variant="destructive"
                onClick={handleClose}
                disabled={isPendingClose}
              >
                {isPendingClose ? "Closing…" : "Yes, close account"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
