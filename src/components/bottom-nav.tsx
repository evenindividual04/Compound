"use client";

import type React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  Inbox,
  ArrowLeftRight,
  PieChart,
  MoreHorizontal,
} from "lucide-react";

type NavItem = {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  badgeId?: string;
};

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Home", Icon: Home },
  { href: "/inbox", label: "Inbox", Icon: Inbox, badgeId: "inbox-badge" },
  { href: "/transactions", label: "Transactions", Icon: ArrowLeftRight },
  { href: "/budgets", label: "Budgets", Icon: PieChart },
  { href: "/settings", label: "More", Icon: MoreHorizontal },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="flex h-14 items-stretch">
        {NAV_ITEMS.map(({ href, label, Icon, badgeId }) => {
          const isActive =
            href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <li key={href} className="flex flex-1">
              <Link
                href={href}
                className={`relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors ${
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                aria-current={isActive ? "page" : undefined}
              >
                <span className="relative">
                  <Icon className="h-5 w-5" strokeWidth={isActive ? 2.5 : 2} />
                  {badgeId && (
                    <span
                      id={badgeId}
                      className="absolute -right-1 -top-1 hidden h-2 w-2 rounded-full bg-primary"
                    />
                  )}
                </span>
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
