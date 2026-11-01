import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils/cn";

const badgeVariants = cva(
  "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-tight ring-1 ring-inset whitespace-nowrap",
  {
    variants: {
      variant: {
        neutral: "bg-slate-100 text-slate-700 ring-slate-300/70",
        info: "bg-sky-50 text-sky-800 ring-sky-600/25",
        success: "bg-emerald-50 text-emerald-800 ring-emerald-600/25",
        warning: "bg-amber-50 text-amber-800 ring-amber-600/30",
        danger: "bg-red-50 text-red-800 ring-red-600/25",
        critical: "bg-red-600 text-white ring-red-700",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export function statusBadgeVariant(status: string): BadgeProps["variant"] {
  if (["CRITICAL"].includes(status)) return "critical";
  if (["HIGH", "DENIED", "REJECTED", "ON_HOLD_EXCEPTION", "EXPIRED", "CANCELLED", "QUARANTINE_QUALITY"].includes(status)) return "danger";
  if (
    [
      "MEDIUM",
      "OPEN",
      "IN_REVIEW",
      "BACKORDERED",
      "PENDING_REVIEW",
      "PENDING_BUYER_APPROVAL",
      "PENDING_MANAGER_APPROVAL",
      "QUARANTINE_REFURBISHMENT",
      "RESERVED",
    ].includes(status)
  ) {
    return "warning";
  }
  if (["CONFIRMED", "PARTIALLY_SHIPPED", "SHIPPED", "BOOKED", "IN_TRANSIT", "APPROVED", "INSPECTED", "LOW"].includes(status)) return "info";
  if (["DELIVERED", "RESOLVED", "APPROVED_AND_DISPATCHED", "RECEIVED", "REFUNDED", "PRIME", "CONVERTED"].includes(status)) return "success";
  return "neutral";
}
