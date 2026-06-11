"use client";

import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { Input } from "@/components/ui/input";

export interface CategoryOption {
  id: string;
  name: string;
  parentName: string | null;
  classification: "income" | "expense";
}

interface Props {
  categories: CategoryOption[];
  value: string | null;
  onSelect: (id: string | null) => void;
}

export function CategoryPicker({ categories, value, onSelect }: Props) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return categories;
    return categories.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.parentName ?? "").toLowerCase().includes(q),
    );
  }, [categories, query]);

  // Group by parentName
  const groups = useMemo(() => {
    const map = new Map<string, CategoryOption[]>();
    for (const c of filtered) {
      const key = c.parentName ?? "General";
      const arr = map.get(key) ?? [];
      arr.push(c);
      map.set(key, arr);
    }
    return map;
  }, [filtered]);

  return (
    <div className="flex flex-col gap-2">
      <Input
        placeholder="Search categories…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="h-8 text-sm"
      />
      <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
        {/* Uncategorized option */}
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn(
            "flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-muted",
            value === null && "bg-muted/60",
          )}
        >
          <span className="text-muted-foreground italic">Uncategorized</span>
          {value === null && <Check className="h-4 w-4 text-primary" />}
        </button>
        {Array.from(groups.entries()).map(([groupName, cats]) => (
          <div key={groupName}>
            <div className="sticky top-0 bg-background px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {groupName}
            </div>
            {cats.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => onSelect(cat.id)}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-muted",
                  value === cat.id && "bg-muted/60",
                )}
              >
                <span>{cat.name}</span>
                {value === cat.id && <Check className="h-4 w-4 text-primary" />}
              </button>
            ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="px-3 py-4 text-center text-sm text-muted-foreground">
            No categories match
          </p>
        )}
      </div>
    </div>
  );
}
