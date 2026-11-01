"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "./button";

export function RouteErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-red-200 bg-red-50/70 p-6">
      <div className="flex items-center gap-2 text-red-800">
        <AlertTriangle className="h-5 w-5" />
        <h2 className="text-sm font-semibold">Unable to load view</h2>
      </div>
      <p className="text-xs text-red-700">{error.message || "An unexpected error occurred while loading data."}</p>
      <Button size="sm" variant="outline" onClick={reset}>
        Retry
      </Button>
    </div>
  );
}
