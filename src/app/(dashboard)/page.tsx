import { Suspense } from "react";
import Link from "next/link";
import { getOpenExceptionCounts, getOpenExceptions } from "@/modules/exceptions/queries";
import { getOpenRequisitionList, getStockOverview } from "@/modules/inventory/queries";
import { computeRop } from "@/modules/inventory/rules";
import { getOrders } from "@/modules/orders/queries";
import { Badge, statusBadgeVariant } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableSkeleton } from "@/components/ui/skeleton";
import { DataTable, RowTh, Td, Th, THead } from "@/components/ui/table";
import { formatMoney } from "@/lib/utils/money";

async function KpiStrip() {
  const [exCounts, ordersPage, openReqs] = await Promise.all([
    getOpenExceptionCounts(),
    getOrders(undefined, 20),
    getOpenRequisitionList(50),
  ]);
  const heldOrders = ordersPage.rows.filter((o) => o.status === "ON_HOLD_EXCEPTION" || o.status === "BACKORDERED").length;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card>
        <CardContent className="py-3.5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Live Exceptions</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-bold text-slate-900 tabular-nums">{exCounts.open}</span>
            <Badge variant={exCounts.overdue > 0 ? "critical" : "warning"}>{exCounts.overdue} SLA overdue</Badge>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="py-3.5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Critical / High Queue</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-bold text-slate-900 tabular-nums">
              {(exCounts.bySeverity["CRITICAL"] ?? 0) + (exCounts.bySeverity["HIGH"] ?? 0)}
            </span>
            <Link href="/exceptions" className="text-xs font-medium text-slate-700 underline">
              Triage →
            </Link>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="py-3.5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Held / Backordered (Recent)</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-bold text-slate-900 tabular-nums">{heldOrders}</span>
            <Link href="/orders" className="text-xs font-medium text-slate-700 underline">
              Orders →
            </Link>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="py-3.5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Open Requisitions</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-bold text-slate-900 tabular-nums">{openReqs.length}</span>
            <Link href="/procurement" className="text-xs font-medium text-slate-700 underline">
              Convert →
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

async function TopExceptionsPanel() {
  const page = await getOpenExceptions(undefined, 8);
  return (
    <Card className="panel-contain">
      <CardHeader>
        <CardTitle>Urgent Exception Queue (SLA-Ordered)</CardTitle>
        <Link href="/exceptions" className="text-xs font-medium text-slate-700 underline">
          Full Queue →
        </Link>
      </CardHeader>
      <CardContent className="p-0">
        {page.rows.length === 0 ? (
          <p className="p-4 text-xs text-slate-500">Zero open exceptions — deterministic automation is running nominal.</p>
        ) : (
          <DataTable label="Urgent open exceptions" className="border-0 rounded-none">
            <THead>
              <tr>
                <Th>ID</Th>
                <Th>Severity</Th>
                <Th>Type</Th>
                <Th>Entity</Th>
                <Th>Reason</Th>
                <Th>SLA Due (UTC)</Th>
              </tr>
            </THead>
            <tbody>
              {page.rows.map((ex) => (
                <tr key={ex.id}>
                  <RowTh>#{ex.id}</RowTh>
                  <Td label="Severity">
                    <Badge variant={statusBadgeVariant(ex.severity)}>{ex.severity}</Badge>
                  </Td>
                  <Td label="Type" className="font-mono text-[11px]">
                    {ex.type}
                  </Td>
                  <Td label="Entity" className="font-mono text-[11px]">
                    {ex.entityType}:{ex.entityId}
                  </Td>
                  <Td label="Reason">{ex.reasonCode}</Td>
                  <Td label="SLA Due" className="font-mono text-[11px] tabular-nums">
                    {ex.dueAt.toISOString().slice(0, 16).replace("T", " ")}
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </CardContent>
    </Card>
  );
}

async function RopWatchPanel() {
  const [stock, orders] = await Promise.all([getStockOverview(0, 10), getOrders(undefined, 6)]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="panel-contain">
        <CardHeader>
          <CardTitle>Inventory Position vs Reorder Point (ROP)</CardTitle>
          <Link href="/inventory" className="text-xs font-medium text-slate-700 underline">
            Inventory →
          </Link>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable label="Inventory ROP watchlist" className="border-0 rounded-none">
            <THead>
              <tr>
                <Th>SKU</Th>
                <Th>PRIME Avail</Th>
                <Th>ROP</Th>
                <Th>Quarantine</Th>
              </tr>
            </THead>
            <tbody>
              {stock.rows.map((s) => {
                const { rop } = computeRop({ dAvg: s.dAvg, sigmaD: s.sigmaD, lAvg: s.leadTimeDays, z: stock.rules.serviceLevelZ });
                const below = s.qtyAvailable <= rop;
                return (
                  <tr key={s.skuId}>
                    <RowTh>{s.code}</RowTh>
                    <Td label="PRIME Avail" className="font-mono tabular-nums">
                      <Badge variant={below ? "warning" : "success"}>{s.qtyAvailable}</Badge>
                    </Td>
                    <Td label="ROP" className="font-mono tabular-nums">
                      {rop.toFixed(1)}
                    </Td>
                    <Td label="Quarantine" className="font-mono tabular-nums">
                      {s.qtyQuarantined}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </CardContent>
      </Card>

      <Card className="panel-contain">
        <CardHeader>
          <CardTitle>Latest Customer Orders</CardTitle>
          <Link href="/orders" className="text-xs font-medium text-slate-700 underline">
            All Orders →
          </Link>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable label="Latest customer orders" className="border-0 rounded-none">
            <THead>
              <tr>
                <Th>Order</Th>
                <Th>Customer</Th>
                <Th>Status</Th>
                <Th>Total</Th>
              </tr>
            </THead>
            <tbody>
              {orders.rows.map((o) => (
                <tr key={o.id}>
                  <RowTh>{o.orderNumber}</RowTh>
                  <Td label="Customer">{o.customerName}</Td>
                  <Td label="Status">
                    <Badge variant={statusBadgeVariant(o.status)}>{o.status}</Badge>
                  </Td>
                  <Td label="Total" className="font-mono tabular-nums">
                    {formatMoney(o.totalCents)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </CardContent>
      </Card>
    </div>
  );
}

export default function ControlTowerPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-slate-900">Control Tower Overview</h1>
        <p className="text-xs text-slate-500">
          Routine supply-chain operations execute deterministically; human operators intervene strictly on threshold or compliance exceptions.
        </p>
      </div>
      <Suspense fallback={<TableSkeleton rows={2} />}>
        <KpiStrip />
      </Suspense>
      <Suspense fallback={<TableSkeleton rows={6} />}>
        <TopExceptionsPanel />
      </Suspense>
      <Suspense fallback={<TableSkeleton rows={5} />}>
        <RopWatchPanel />
      </Suspense>
    </div>
  );
}
