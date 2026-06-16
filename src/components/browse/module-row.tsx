import type React from "react";
import Link from "next/link";

interface ModuleRowProps {
  icon: React.ReactNode;
  label: string;
  href?: string;
  pinned?: boolean;
  soon?: boolean;
  badge?: number;
  dimmed?: boolean;
}

function ChevronRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--hairline)" }}>
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  );
}

export function ModuleRow({ icon, label, href, pinned, soon, badge, dimmed }: ModuleRowProps) {
  const content = (
    <span className="flex flex-1 items-center gap-3" style={{ padding: "9px 20px" }}>
      {/* Icon wrap */}
      <span
        className="flex items-center justify-center rounded-lg bg-paper"
        style={{
          width: "32px",
          height: "32px",
          border: "1px solid var(--hairline)",
          flexShrink: 0,
          color: pinned ? "var(--coral)" : "var(--soft)",
        }}
      >
        {icon}
      </span>

      {/* Label */}
      <span
        style={{
          flex: 1,
          fontSize: "13px",
          fontWeight: dimmed ? 400 : 500,
          color: dimmed ? "var(--soft)" : "var(--ink)",
        }}
      >
        {label}
      </span>

      {/* Right-side decorations */}
      <span className="flex items-center gap-1.5">
        {pinned && (
          <span
            className="rounded-full bg-coral"
            style={{ width: "6px", height: "6px" }}
          />
        )}
        {soon && (
          <span
            className="rounded-[10px] bg-paper"
            style={{
              border: "1px solid var(--hairline)",
              fontSize: "9px",
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--soft)",
              padding: "2px 7px",
              opacity: 0.7,
            }}
          >
            Soon
          </span>
        )}
        {badge !== undefined && badge > 0 && (
          <span
            className="tnum rounded-[10px] bg-coral text-coral-text"
            style={{
              fontSize: "9px",
              fontWeight: 700,
              padding: "2px 7px",
            }}
          >
            {badge > 99 ? "99+" : badge}
          </span>
        )}
        <ChevronRight />
      </span>
    </span>
  );

  const liClass = "flex [&:not(:first-child)]:border-t";
  const liStyle = { borderColor: "var(--hairline)" } as React.CSSProperties;

  if (href) {
    return (
      <li className={liClass} style={liStyle}>
        <Link href={href} className="flex flex-1">
          {content}
        </Link>
      </li>
    );
  }

  return (
    <li className={liClass} style={liStyle}>
      {content}
    </li>
  );
}
