"use client";

import React, { type ReactNode } from "react";
import {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { CategoryPicker, type CategoryOption } from "@/components/category-picker";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: CategoryOption[];
  currentValue: string | null;
  onSelect: (categoryId: string | null) => void;
  trigger?: ReactNode;
}

export function CategoryPickerDialog({
  open,
  onOpenChange,
  categories,
  currentValue,
  onSelect,
  trigger,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger render={trigger as React.ReactElement} />}
      <DialogPortal>
        <DialogOverlay />
        <DialogContent className="max-w-sm">
          <DialogTitle>Choose category</DialogTitle>
          <CategoryPicker
            categories={categories}
            value={currentValue}
            onSelect={onSelect}
          />
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
