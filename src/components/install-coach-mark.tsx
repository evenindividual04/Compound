"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

const STORAGE_KEY = "install-coach-dismissed";

function isIosSafariNotStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  const isIos = /iPhone|iPad|iPod/.test(ua);
  // navigator.standalone is an Apple extension
  const isStandalone =
    "standalone" in window.navigator &&
    (window.navigator as { standalone?: boolean }).standalone === true;
  return isIos && !isStandalone;
}

export function InstallCoachMark() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isIosSafariNotStandalone()) return;
    try {
      if (localStorage.getItem(STORAGE_KEY)) return;
    } catch {
      // ignore localStorage errors
    }
    setVisible(true);
  }, []);

  function dismiss() {
    setVisible(false);
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // ignore
    }
  }

  if (!visible) return null;

  return (
    <div className="fixed bottom-16 left-0 right-0 z-50 mx-4 flex items-center justify-between rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-card-foreground shadow-lg"
      style={{ marginBottom: "env(safe-area-inset-bottom)" }}
    >
      <span>Install: Share → Add to Home Screen</span>
      <button
        onClick={dismiss}
        className="ml-3 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
