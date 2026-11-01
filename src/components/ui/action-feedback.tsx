"use client";

export function ActionFeedback({ error, message }: { error: string | null; message: string | null }) {
  if (error) {
    return (
      <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
        {error}
      </div>
    );
  }
  if (message) {
    return (
      <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
        {message}
      </div>
    );
  }
  return null;
}
