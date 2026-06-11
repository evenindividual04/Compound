import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-background px-4 pt-12">
      {/* Hero */}
      <section className="flex flex-col items-center gap-2 py-8">
        <p className="text-sm text-muted-foreground">spent this month</p>
        <p className="tnum text-6xl font-semibold tracking-tight text-foreground">
          ₹0
        </p>
      </section>

      {/* Placeholder metric cards */}
      <section className="grid grid-cols-1 gap-4 pb-8 sm:grid-cols-3">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </section>
    </div>
  );
}
