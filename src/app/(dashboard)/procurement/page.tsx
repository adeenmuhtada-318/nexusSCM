import { Suspense } from "react";
import Link from "next/link";
import { getOpenRequisitionList, getWarehouseOptions } from "@/modules/inventory/queries";
import { getPurchaseOrders } from "@/modules/procurement/queries";
import {
  ConvertRequisitionButton,
  PoRowActions,
  RunReplenishmentButton,
} from "@/modules/procurement/components/procurement-actions";
import { Badge, statusBadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableSkeleton } from "@/components/ui/skeleton";
import { DataTable, RowTh, Td, Th, THead } from "@/components/ui/table";
import { formatMoney } from "@/lib/utils/money";

async function ProcurementContent({ cursor }: { cursor: string | undefined }) {
  const [pos, openReqs, warehouses] = await Promise.all([
    getPurchaseOrders(cursor, 25),
    getOpenRequisitionList(50),
    getWarehouseOptions(),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-600">
          Tier 1 → 2 → 3 vendor cascade · Auto-dispatches under $10,000 on Tier 1/2 · Same-day split-PO spend guard · Separation of duties (`approver ≠ requester`).
        </p>
        <RunReplenishmentButton />
      </div>

      <Card className="panel-contain">
        <CardHeader>
          <CardTitle>Purchase Orders</CardTitle>
          {cursor && (
            <Link href="/procurement" className="text-xs font-medium text-slate-700 underline">
              ← First Page
            </Link>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {pos.rows.length === 0 ? (
            <p className="p-6 text-center text-xs text-slate-500">No purchase orders generated yet.</p>
          ) : (
            <DataTable label="Purchase orders" className="border-0 rounded-none">
              <THead>
                <tr>
                  <Th>PO Number</Th>
                  <Th>Vendor</Th>
                  <Th>Tier</Th>
                  <Th>Status</Th>
                  <Th>Total Cost</Th>
                  <Th>Created</Th>
                  <Th>Actions</Th>
                </tr>
              </THead>
              <tbody>
                {pos.rows.map((po) => (
                  <tr key={po.id}>
                    <RowTh>{po.poNumber}</RowTh>
                    <Td label="Vendor">{po.vendorName}</Td>
                    <Td label="Tier">
                      <Badge variant={po.hierarchyTier === 3 ? "warning" : "neutral"}>Tier {po.hierarchyTier}</Badge>
                    </Td>
                    <Td label="Status">
                      <Badge variant={statusBadgeVariant(po.status)}>{po.status}</Badge>
                    </Td>
                    <Td label="Total Cost" className="font-mono tabular-nums font-medium">
                      {formatMoney(po.totalCostCents)}
                    </Td>
                    <Td label="Created" className="font-mono text-[11px]">
                      {po.createdAt.toISOString().slice(0, 10)}
                    </Td>
                    <Td label="Actions">
                      <PoRowActions poId={po.id} status={po.status} warehouses={warehouses} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
          {pos.nextCursor && (
            <div className="flex justify-end border-t border-slate-100 px-4 py-2.5">
              <Button asChild size="sm" variant="outline">
                <Link href={`/procurement?cursor=${encodeURIComponent(pos.nextCursor)}`}>Next Page →</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="panel-contain">
        <CardHeader>
          <CardTitle>Open Purchase Requisitions ({openReqs.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {openReqs.length === 0 ? (
            <p className="p-4 text-xs text-slate-500">No unconverted requisitions open.</p>
          ) : (
            <DataTable label="Open purchase requisitions" className="border-0 rounded-none">
              <THead>
                <tr>
                  <Th>Req ID</Th>
                  <Th>SKU</Th>
                  <Th>Order Qty</Th>
                  <Th>Created</Th>
                  <Th>Convert</Th>
                </tr>
              </THead>
              <tbody>
                {openReqs.map((r) => (
                  <tr key={r.id}>
                    <RowTh>REQ-{r.id}</RowTh>
                    <Td label="SKU" className="font-mono">
                      {r.skuCode}
                    </Td>
                    <Td label="Order Qty" className="font-mono tabular-nums">
                      {r.qty}
                    </Td>
                    <Td label="Created" className="font-mono text-[11px]">
                      {r.createdAt.toISOString().slice(0, 10)}
                    </Td>
                    <Td label="Convert">
                      <ConvertRequisitionButton requisitionId={r.id} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default async function ProcurementPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const sp = await searchParams;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-slate-900">Procurement, Vendor Cascade & PO Approvals</h1>
        <p className="text-xs text-slate-500">
          Enforces ≥ $10,000 manager sign-off, Tier-3 spot buyer review, same-day vendor/SKU split-PO guard, and DB-backed separation of duties.
        </p>
      </div>
      <Suspense fallback={<TableSkeleton rows={8} />}>
        <ProcurementContent cursor={sp.cursor} />
      </Suspense>
    </div>
  );
}
