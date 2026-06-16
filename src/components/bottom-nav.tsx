"use client";

import type React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface BottomNavProps {
  inboxCount?: number;
  onFabClick: () => void;
}

function HomeIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10L12 3l9 7v9a1 1 0 01-1 1H4a1 1 0 01-1-1v-9z"/>
      <path d="M9 21v-9h6v9"/>
    </svg>
  );
}

function BrowseIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5"/>
      <rect x="14" y="3" width="7" height="7" rx="1.5"/>
      <rect x="3" y="14" width="7" height="7" rx="1.5"/>
      <rect x="14" y="14" width="7" height="7" rx="1.5"/>
    </svg>
  );
}

function TrendsIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3,17 9,11 13,15 21,7"/>
      <polyline points="14,7 21,7 21,14"/>
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="12" r="1.5"/>
      <circle cx="12" cy="12" r="1.5"/>
      <circle cx="19" cy="12" r="1.5"/>
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="10" y1="4" x2="10" y2="16"/>
      <line x1="4" y1="10" x2="16" y2="10"/>
    </svg>
  );
}

type NavSlot = {
  href: string;
  label: string;
  Icon: () => React.JSX.Element;
};

const LEFT_SLOTS: NavSlot[] = [
  { href: "/", label: "Home", Icon: HomeIcon },
  { href: "/browse", label: "Browse", Icon: BrowseIcon },
];

const RIGHT_SLOTS: NavSlot[] = [
  { href: "/trends", label: "Trends", Icon: TrendsIcon },
  { href: "/settings", label: "More", Icon: MoreIcon },
];

export function BottomNav({ onFabClick }: BottomNavProps) {
  const pathname = usePathname();

  function isActive(href: string) {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 border-t bg-surface"
      style={{
        borderTopColor: "var(--hairline)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <ul className="flex items-stretch" style={{ height: "54px" }}>
        {/* Left two slots */}
        {LEFT_SLOTS.map(({ href, label, Icon }) => {
          const active = isActive(href);
          return (
            <li key={href} className="flex flex-1">
              <Link
                href={href}
                className="flex flex-1 flex-col items-center justify-center gap-0.5"
                aria-current={active ? "page" : undefined}
                style={{
                  color: active ? "var(--coral)" : "var(--soft)",
                }}
              >
                <Icon />
                <span
                  style={{
                    fontSize: "9px",
                    fontWeight: active ? 600 : 500,
                    color: active ? "var(--coral)" : "var(--soft)",
                  }}
                >
                  {label}
                </span>
              </Link>
            </li>
          );
        })}

        {/* Center FAB slot */}
        <li className="flex flex-1 items-center justify-center">
          <button
            aria-label="Quick entry"
            onClick={onFabClick}
            className="flex items-center justify-center rounded-full bg-coral transition-transform active:scale-95 hover:scale-105"
            style={{ width: "44px", height: "44px" }}
          >
            <span style={{ color: "var(--coral-text)" }}>
              <PlusIcon />
            </span>
          </button>
        </li>

        {/* Right two slots */}
        {RIGHT_SLOTS.map(({ href, label, Icon }) => {
          const active = isActive(href);
          return (
            <li key={href} className="flex flex-1">
              <Link
                href={href}
                className="flex flex-1 flex-col items-center justify-center gap-0.5"
                aria-current={active ? "page" : undefined}
                style={{
                  color: active ? "var(--coral)" : "var(--soft)",
                }}
              >
                <Icon />
                <span
                  style={{
                    fontSize: "9px",
                    fontWeight: active ? 600 : 500,
                    color: active ? "var(--coral)" : "var(--soft)",
                  }}
                >
                  {label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
