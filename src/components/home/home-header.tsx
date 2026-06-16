import Link from "next/link";

interface HomeHeaderProps {
  monthLabel: string;
  greeting: string;
  attentionCount: number;
  avatarInitials: string;
}

export function HomeHeader({
  monthLabel,
  greeting,
  attentionCount,
  avatarInitials,
}: HomeHeaderProps) {
  return (
    <div className="flex items-start justify-between px-4 pt-5 pb-3">
      {/* Left: month + greeting */}
      <div className="flex flex-col gap-0.5">
        <p
          className="text-[9px] font-semibold uppercase tracking-[0.12em] text-soft"
          style={{ letterSpacing: "0.12em" }}
        >
          {monthLabel}
        </p>
        <p className="text-[15px] font-semibold text-ink leading-snug">{greeting}</p>
      </div>

      {/* Right: bell + avatar */}
      <div className="flex items-center gap-2.5">
        {/* Bell with optional coral badge */}
        <Link href="/inbox" className="relative p-1">
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M10 2a5.5 5.5 0 0 0-5.5 5.5v2.25L3 11.5V13h14v-1.5l-1.5-1.75V7.5A5.5 5.5 0 0 0 10 2Z"
              stroke="var(--ink)"
              strokeWidth="1.5"
              strokeLinejoin="round"
              fill="none"
            />
            <path
              d="M8 14.5a2 2 0 0 0 4 0"
              stroke="var(--ink)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          {attentionCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-coral text-[9px] font-bold text-coral-text leading-none">
              {attentionCount > 9 ? "9+" : attentionCount}
            </span>
          )}
        </Link>

        {/* Avatar */}
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface border border-hairline">
          <span className="text-[11px] font-semibold text-soft uppercase">{avatarInitials}</span>
        </div>
      </div>
    </div>
  );
}
