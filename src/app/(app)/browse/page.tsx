import {
  ShoppingCart,
  PieChart,
  PiggyBank,
  TrendingUp,
  Landmark,
  ArrowLeftRight,
  LineChart,
  Target,
  Receipt,
  RefreshCcw,
  CreditCard,
  BarChart2,
  Inbox,
  Upload,
  FileText,
  Shield,
  Star,
  Cable,
} from "lucide-react";
import { db } from "@/db";
import { requireHousehold } from "@/lib/current";
import { inboxCount } from "@/lib/ledger/inbox";
import { ModuleGroup } from "@/components/browse/module-group";
import { ModuleRow } from "@/components/browse/module-row";

const ICON_PROPS = { size: 16, strokeWidth: 1.6 } as const;

export default async function BrowsePage() {
  const { householdId } = await requireHousehold();
  const count = await inboxCount(db, householdId);

  return (
    <div className="min-h-screen" style={{ paddingBottom: "24px" }}>
      {/* Header */}
      <header style={{ padding: "8px 20px 10px" }}>
        <h1
          className="font-display text-ink"
          style={{ fontSize: "34px", fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.1 }}
        >
          Browse
        </h1>
        <p className="text-soft" style={{ fontSize: "12px", marginTop: "2px" }}>
          Everything, one place.
        </p>
      </header>

      {/* Search bar (visual only) */}
      <div style={{ margin: "6px 16px 0" }}>
        <div
          className="bg-surface flex items-center gap-2"
          style={{
            border: "1px solid var(--hairline)",
            borderRadius: "10px",
            padding: "7px 10px",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--soft)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <span className="text-soft" style={{ fontSize: "12px" }}>Search modules…</span>
        </div>
      </div>

      {/* Groups */}
      <div style={{ marginTop: "20px", display: "flex", flexDirection: "column", gap: "4px" }}>

        {/* Your Money */}
        <ModuleGroup label="Your Money">
          <ModuleRow
            icon={<ShoppingCart {...ICON_PROPS} />}
            label="Spending"
            href="/transactions"
            pinned
          />
          <ModuleRow
            icon={<PieChart {...ICON_PROPS} />}
            label="Budgets"
            href="/budgets"
            pinned
          />
          <ModuleRow
            icon={<PiggyBank {...ICON_PROPS} />}
            label="Savings"
            pinned
          />
          <ModuleRow
            icon={<Landmark {...ICON_PROPS} />}
            label="Net worth"
            href="/accounts"
          />
          <ModuleRow
            icon={<ArrowLeftRight {...ICON_PROPS} />}
            label="Accounts"
            href="/accounts"
          />
          <ModuleRow
            icon={<Cable {...ICON_PROPS} />}
            label="Setup"
            href="/browse/setup"
          />
          <ModuleRow
            icon={<TrendingUp {...ICON_PROPS} />}
            label="Cash flow"
          />
        </ModuleGroup>

        {/* Grow */}
        <ModuleGroup label="Grow">
          <ModuleRow
            icon={<Star {...ICON_PROPS} />}
            label="Compound"
            href="/"
            pinned
          />
          <ModuleRow
            icon={<LineChart {...ICON_PROPS} />}
            label="Investments"
            soon
          />
          <ModuleRow
            icon={<Target {...ICON_PROPS} />}
            label="Goals"
            soon
          />
        </ModuleGroup>

        {/* Obligations */}
        <ModuleGroup label="Obligations">
          <ModuleRow
            icon={<Receipt {...ICON_PROPS} />}
            label="Bills"
            soon
          />
          <ModuleRow
            icon={<RefreshCcw {...ICON_PROPS} />}
            label="Subscriptions"
            soon
          />
          <ModuleRow
            icon={<CreditCard {...ICON_PROPS} />}
            label="Debt & EMIs"
            soon
          />
        </ModuleGroup>

        {/* Understand */}
        <ModuleGroup label="Understand">
          <ModuleRow
            icon={<BarChart2 {...ICON_PROPS} />}
            label="Trends"
            href="/trends"
          />
          <ModuleRow
            icon={<Inbox {...ICON_PROPS} />}
            label="Review inbox"
            href="/inbox"
            badge={count}
          />
          <ModuleRow
            icon={<Upload {...ICON_PROPS} />}
            label="Import"
            href="/import"
          />
        </ModuleGroup>

        {/* Later (dimmed) */}
        <ModuleGroup label="Later" dimmed>
          <ModuleRow
            icon={<FileText {...ICON_PROPS} />}
            label="Taxes"
            dimmed
          />
          <ModuleRow
            icon={<Shield {...ICON_PROPS} />}
            label="Insurance"
            dimmed
          />
          <ModuleRow
            icon={<Star {...ICON_PROPS} />}
            label="Credit score"
            dimmed
          />
        </ModuleGroup>

      </div>
    </div>
  );
}
