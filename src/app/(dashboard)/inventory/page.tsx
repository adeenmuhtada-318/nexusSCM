import { Suspense } from "react";
import Link from "next/link";
import { getActiveSkus, getRecentBatches, getStockOverview, getWarehouseOptions } from "@/modules/inventory/queries";
import { computeRop } from "@/modules/inventory/rules";
import { AdjustBatchModal, ReceiveStockModal } from "@/modules/inventory/components/inventory-actions";
import { Badge, statusBadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableSkeleton } from "@/components/ui/skeleton";
import { DataTable, RowTh, Td, Th, THead } from "@/components/ui/table";

async function InventoryTables({ afterSkuId }: { afterSkuId: number }) {
  const [stock, batches, skus, warehouses] = await Promise.all([
    getStockOverview(afterSkuId, 20),
    getRecentBatches(25),
    getActiveSkus(),
    getWarehouseOptions(),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-600">
          Service level Z = <span className="font-mono font-semibold">{stock.rules.serviceLevelZ}</span> · Min perishable shelf life ={" "}
          <span className="font-mono font-semibold">{stock.rules.minShelfLifePct}%</span>
        </p>
        <ReceiveStockModal skus={skus} warehouses={warehouses} />
      </div>

      <Card className="panel-contain">
        <CardHeader>
          <CardTitle>SKU Stock & ROP Signals (90-Day Trailing Ledger Demand)</CardTitle>
          {afterSkuId > 0 && (
            <Link href="/inventory" className="text-xs font-medium text-slate-700 underline">
              ← First Page
            </Link>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <DataTable label="SKU stock and reorder points" className="border-0 rounded-none">
            <THead>
              <tr>
                <Th>SKU</Th>
                <Th>Name</Th>
                <Th>Rotation</Th>
                <Th>PRIME Avail</Th>
                <Th>Reserved</Th>
                <Th>Quarantine</Th>
                <Th>D_avg / day</Th>
                <Th>ROP</Th>
                <Th>Open Req</Th>
              </tr>
            </THead>
            <tbody>
              {stock.rows.map((s) => {
                const { rop } = computeRop({ dAvg: s.dAvg, sigmaD: s.sigmaD, lAvg: s.leadTimeDays, z: stock.rules.serviceLevelZ });
                return (
                  <tr key={s.skuId}>
                    <RowTh>{s.code}</RowTh>
                    <Td label="Name">{s.name}</Td>
                    <Td label="Rotation">
                      <Badge variant={s.isPerishable ? "info" : "neutral"}>{s.isPerishable ? "FEFO" : "FIFO"}</Badge>
                    </Td>
                    <Td label="PRIME Avail" className="font-mono tabular-nums font-semibold">
                      {s.qtyAvailable}
                    </Td>
                    <Td label="Reserved" className="font-mono tabular-nums">
                      {s.qtyReserved}
                    </Td>
                    <Td label="Quarantine" className="font-mono tabular-nums">
                      {s.qtyQuarantined}
                    </Td>
                    <Td label="D_avg" className="font-mono tabular-nums">
                      {s.dAvg.toFixed(2)}
                    </Td>
                    <Td label="ROP" className="font-mono tabular-nums">
                      {rop.toFixed(1)}
                    </Td>
                    <Td label="Open Req">
                      <Badge variant={s.hasOpenRequisition ? "warning" : "neutral"}>{s.hasOpenRequisition ? "OPEN" : "—"}</Badge>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
          {stock.nextCursor !== null && (
            <div className="flex justify-end border-t border-slate-100 px-4 py-2.5">
              <Button asChild size="sm" variant="outline">
                <Link href={`/inventory?after=${stock.nextCursor}`}>Next Page →</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="panel-contain">
        <CardHeader>
          <CardTitle>Recent Batches & Quarantine Zones (Append-Only Ledger Backed)</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable label="Recent inventory batches" className="border-0 rounded-none">
            <THead>
              <tr>
                <Th>Batch</Th>
                <Th>SKU</Th>
                <Th>Warehouse</Th>
                <Th>Zone</Th>
                <Th>Lot</Th>
                <Th>Avail</Th>
                <Th>Reserved</Th>
                <Th>Expiry</Th>
                <Th>Cycle Count</Th>
              </tr>
            </THead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <RowTh>#{b.id}</RowTh>
                  <Td label="SKU" className="font-mono text-[11px]">
                    {b.skuCode}
                  </Td>
                  <Td label="Warehouse" className="font-mono text-[11px]">
                    {b.warehouseCode}
                  </Td>
                  <Td label="Zone">
                    <Badge variant={statusBadgeVariant(b.zoneStatus)}>{b.zoneStatus}</Badge>
                  </Td>
                  <Td label="Lot" className="font-mono text-[11px]">
                    {b.lotCode}
                  </Td>
                  <Td label="Avail" className="font-mono tabular-nums">
                    {b.qtyAvailable}
                  </Td>
                  <Td label="Reserved" className="font-mono tabular-nums">
                    {b.qtyReserved}
                  </Td>
                  <Td label="Expiry" className="font-mono text-[11px]">
                    {b.expiryDate ?? "—"}
                  </Td>
                  <Td label="Cycle Count">
                    <AdjustBatchModal batchId={b.id} lotCode={b.lotCode} />
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

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ after?: string }>;
}) {
  const sp = await searchParams;
  const afterSkuId = Math.max(0, Number(sp.after ?? "0") || 0);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-slate-900">Inventory, FEFO/FIFO Batches & ROP</h1>
        <p className="text-xs text-slate-500">
          Every mutation runs in an ACID transaction with an append-only signed ledger entry; quarantine zones are strictly excluded from order allocation.
        </p>
      </div>
      <Suspense fallback={<TableSkeleton rows={8} />}>
        <InventoryTables afterSkuId={afterSkuId} />
      </Suspense>
    </div>
  );
}
