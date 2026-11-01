import * as React from "react";
import { cn } from "@/lib/utils/cn";

export function DataTable({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div tabIndex={0} role="region" aria-label={label} className={cn("table-wrapper rounded-md border border-slate-200 bg-white", className)}>
      <table className="text-left text-xs text-slate-700">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{children}</thead>;
}

export function Th({ className, children, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th scope="col" className={cn("border-b border-slate-200 bg-slate-50 px-3 py-2 whitespace-nowrap", className)} {...props}>
      {children}
    </th>
  );
}

export function RowTh({ className, children, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th scope="row" className={cn("border-b border-slate-100 px-3 py-2 font-mono text-xs font-medium text-slate-900 whitespace-nowrap", className)} {...props}>
      {children}
    </th>
  );
}

export function Td({ className, label, children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement> & { label?: string }) {
  return (
    <td data-label={label} className={cn("border-b border-slate-100 px-3 py-2 align-middle", className)} {...props}>
      {children}
    </td>
  );
}
