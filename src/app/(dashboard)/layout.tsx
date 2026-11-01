import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertOctagon,
  Boxes,
  ClipboardList,
  Factory,
  LayoutDashboard,
  LogOut,
  RotateCcw,
  Truck,
} from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { signOutAction } from "@/lib/auth/actions";
import { getOpenExceptionCounts } from "@/modules/exceptions/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const NAV_ITEMS = [
  { href: "/", label: "Control Tower", icon: LayoutDashboard },
  { href: "/exceptions", label: "Exception Queue", icon: AlertOctagon, badge: true },
  { href: "/inventory", label: "Inventory & Batches", icon: Boxes },
  { href: "/orders", label: "Orders & Holds", icon: ClipboardList },
  { href: "/logistics", label: "Logistics & Carriers", icon: Truck },
  { href: "/procurement", label: "Procurement & POs", icon: Factory },
  { href: "/returns", label: "Returns & RMAs", icon: RotateCcw },
] as const;

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const counts = await getOpenExceptionCounts();

  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-950 text-slate-200">
        <div className="border-b border-slate-800 px-4 py-3.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold tracking-tight text-white">NexusSCM</span>
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-400">
              HITL v1
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-400">Management by Exception</p>
        </div>

        <nav className="flex-1 space-y-0.5 p-2" aria-label="Primary Supply Chain Modules">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center justify-between rounded-md px-2.5 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-900 hover:text-white"
              >
                <span className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-slate-400" />
                  {item.label}
                </span>
                {"badge" in item && item.badge && counts.open > 0 && (
                  <Badge variant={counts.overdue > 0 ? "critical" : "warning"}>{counts.open}</Badge>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-slate-800 p-3 text-xs">
          <div className="mb-2 truncate font-mono text-[11px] text-slate-300">{session.email}</div>
          <div className="flex items-center justify-between gap-2">
            <Badge variant="info">{session.role}</Badge>
            <form action={signOutAction}>
              <Button type="submit" size="sm" variant="secondary" className="h-7 px-2 text-[11px]">
                <LogOut className="h-3 w-3" />
                Sign Out
              </Button>
            </form>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="mx-auto w-full max-w-7xl flex-1 space-y-5 p-5">{children}</main>
      </div>
    </div>
  );
}
