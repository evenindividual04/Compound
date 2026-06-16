import type React from "react";

interface ModuleGroupProps {
  label: string;
  children: React.ReactNode;
  dimmed?: boolean;
}

export function ModuleGroup({ label, children, dimmed }: ModuleGroupProps) {
  return (
    <section style={{ opacity: dimmed ? 0.5 : 1 }}>
      <p
        style={{
          fontSize: "9px",
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--soft)",
          padding: "14px 20px 6px",
        }}
      >
        {label}
      </p>
      <div
        className="bg-surface overflow-hidden"
        style={{
          margin: "0 16px",
          borderRadius: "14px",
          border: "1px solid var(--hairline)",
        }}
      >
        <ul>
          {children}
        </ul>
      </div>
    </section>
  );
}
