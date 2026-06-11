import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReactNode } from "react";

interface MetricCardProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
}

/**
 * A compact stat card. Server-friendly (no "use client").
 */
export function MetricCard({ label, value, sub, action }: MetricCardProps) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <div className="tnum text-2xl font-semibold leading-none">{value}</div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
        {action && <div className="mt-1">{action}</div>}
      </CardContent>
    </Card>
  );
}
