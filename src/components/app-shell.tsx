"use client";

import type React from "react";
import { useState } from "react";
import { BottomNav } from "@/components/bottom-nav";
import { QuickEntry } from "@/components/quick-entry";
import { TradeForm } from "@/components/invest/trade-form";
import { InstallCoachMark } from "@/components/install-coach-mark";
import type { CategoryOption, AccountOption } from "@/components/quick-entry";
import type { InvestAccountOption, InstrumentOption } from "@/components/invest/trade-form";

interface AppShellProps {
  children: React.ReactNode;
  inboxCount?: number;
  quickEntryProps: {
    categories: CategoryOption[];
    recentIds: string[];
    accounts: AccountOption[];
  };
  tradeProps: {
    accounts: InvestAccountOption[];
    instruments: InstrumentOption[];
  };
}

export function AppShell({ children, inboxCount, quickEntryProps, tradeProps }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tradeOpen, setTradeOpen] = useState(false);

  const canRecordTrade = tradeProps.accounts.length > 0;

  return (
    <>
      <main className="flex-1 pb-20">{children}</main>
      <BottomNav inboxCount={inboxCount} onFabClick={() => setDrawerOpen(true)} />
      <QuickEntry
        {...quickEntryProps}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onRecordTrade={canRecordTrade ? () => setTradeOpen(true) : undefined}
      />
      {canRecordTrade && (
        <TradeForm {...tradeProps} open={tradeOpen} onOpenChange={setTradeOpen} />
      )}
      <InstallCoachMark />
    </>
  );
}
