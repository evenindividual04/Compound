"use client";

import type React from "react";
import { useState } from "react";
import { BottomNav } from "@/components/bottom-nav";
import { QuickEntry } from "@/components/quick-entry";
import { InstallCoachMark } from "@/components/install-coach-mark";
import type { CategoryOption, AccountOption } from "@/components/quick-entry";

interface AppShellProps {
  children: React.ReactNode;
  inboxCount?: number;
  quickEntryProps: {
    categories: CategoryOption[];
    recentIds: string[];
    accounts: AccountOption[];
  };
}

export function AppShell({ children, inboxCount, quickEntryProps }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      <main className="flex-1 pb-20">{children}</main>
      <BottomNav inboxCount={inboxCount} onFabClick={() => setDrawerOpen(true)} />
      <QuickEntry
        {...quickEntryProps}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
      />
      <InstallCoachMark />
    </>
  );
}
