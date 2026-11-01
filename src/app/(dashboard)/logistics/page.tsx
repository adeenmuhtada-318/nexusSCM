import { Suspense } from "react";
import Link from "next/link";
import { getActiveCarriers, getShipments } from "@/modules/logistics/queries";
import { getRecentFulfillments } from "@/modules/orders/queries";
import { FulfillmentRowActions } from "@/modules/orders/components/order-actions";
import { Badge, statusBadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableSkeleton } from "@/components/ui/skeleton";
import { DataTable, RowTh, Td, Th, THead } from "@/components/ui/table";
import { formatMoney } from "@/lib/utils/money";

async function LogisticsContent({ cursor }: { cursor: string | undefined }) {
  const [shipments, carriers, fulfillments] = await Promise.all([
    getShipments(cursor, 25),
    getActiveCarriers(),
    getRecentFulfillments(20),
  ]);

  return (
    <div className="space-y-5">
      <Card className="panel-contain">
        <CardHeader>
          <CardTitle>Booked Shipments & Carrier Selection Audit</CardTitle>
          {cursor && (
            <Link href="/logistics" className="text-xs font-medium text-slate-700 underline">
              ← First Page
            </Link>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {shipments.rows.length === 0 ? (
            <p className="p-6 text-center text-xs text-slate-500">No shipments booked yet.</p>
          ) : (
            <DataTable label="Booked shipments" className="border-0 rounded-none">
              <THead>
                <tr>
                  <Th>Tracking</Th>
                  <Th>Fulfillment</Th>
                  <Th>Carrier</Th>
                  <Th>Priority</Th>
                  <Th>Selection Rule</Th>
                  <Th>Weight (lbs)</Th>
                  <Th>Freight Cost</Th>
                  <Th>Status</Th>
                </tr>
              </THead>
              <tbody>
                {shipments.rows.map((s) => (
                  <tr key={s.id}>
                    <RowTh>{s.trackingNumber}</RowTh>
                    <Td label="Fulfillment" className="font-mono text-[11px]">
                      FO-{s.fulfillmentOrderId}
                    </Td>
                    <Td label="Carrier" className="font-mono font-semibold">
                      {s.carrierCode}
                    </Td>
                    <Td label="Priority">
                      <Badge variant={s.priority === "URGENT" ? "warning" : "neutral"}>{s.priority}</Badge>
                    </Td>
                    <Td label="Rule" className="font-mono text-[11px]">
                      {s.selectionRule}
                    </Td>
                    <Td label="Weight" className="font-mono tabular-nums">
                      {s.weightLbs}
                    </Td>
                    <Td label="Cost" className="font-mono tabular-nums">
                      {formatMoney(s.costCents)}
                    </Td>
                    <Td label="Status">
                      <Badge variant={statusBadgeVariant(s.status)}>{s.status}</Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
          {shipments.nextCursor && (
            <div className="flex justify-end border-t border-slate-100 px-4 py-2.5">
              <Button asChild size="sm" variant="outline">
                <Link href={`/logistics?cursor=${encodeURIComponent(shipments.nextCursor)}`}>Next Page →</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="panel-contain">
          <CardHeader>
            <CardTitle>Dispatch Queue (Fulfillment Orders)</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DataTable label="Dispatch queue" className="border-0 rounded-none">
              <THead>
                <tr>
                  <Th>FO</Th>
                  <Th>Order</Th>
                  <Th>Hub</Th>
                  <Th>Status</Th>
                  <Th>Action</Th>
                </tr>
              </THead>
              <tbody>
                {fulfillments.map((f) => (
                  <tr key={f.id}>
                    <RowTh>FO-{f.id}</RowTh>
                    <Td label="Order" className="font-mono text-[11px]">
                      {f.orderNumber}
                    </Td>
                    <Td label="Hub" className="font-mono text-[11px]">
                      {f.warehouseCode}
                    </Td>
                    <Td label="Status">
                      <Badge variant={statusBadgeVariant(f.status)}>{f.status}</Badge>
                    </Td>
                    <Td label="Action">
                      <FulfillmentRowActions fulfillmentId={f.id} orderStatus={f.orderStatus} fulfillmentStatus={f.status} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </CardContent>
        </Card>

        <Card className="panel-contain">
          <CardHeader>
            <CardTitle>Active Carrier Compliance & Tariff Matrix</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DataTable label="Active carriers" className="border-0 rounded-none">
              <THead>
                <tr>
                  <Th>Carrier</Th>
                  <Th>Mode</Th>
                  <Th>Hazmat</Th>
                  <Th>Max Wt</Th>
                  <Th>Transit</Th>
                  <Th>Tariff</Th>
                </tr>
              </THead>
              <tbody>
                {carriers.map((c) => (
                  <tr key={c.id}>
                    <RowTh>{c.code}</RowTh>
                    <Td label="Mode" className="text-[11px]">
                      {c.mode}
                    </Td>
                    <Td label="Hazmat">
                      <Badge variant={c.hazmatCertified ? "info" : "neutral"}>{c.hazmatCertified ? "CERTIFIED" : "NO"}</Badge>
                    </Td>
                    <Td label="Max Wt" className="font-mono tabular-nums">
                      {c.maxWeightLbs} lb
                    </Td>
                    <Td label="Transit" className="font-mono tabular-nums">
                      {c.transitDays}d ({Number(c.reliability) * 100}%)
                    </Td>
                    <Td label="Tariff" className="font-mono text-[11px] tabular-nums">
                      {formatMoney(c.baseCostCents)} + {formatMoney(c.costPerLbCents)}/lb
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default async function LogisticsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const sp = await searchParams;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-slate-900">Logistics, Carrier Scoring & Dispatch</h1>
        <p className="text-xs text-slate-500">
          SQL compliance filter drops overweight/oversize/un-certified carriers first; pure rules select Urgent Air, Heavy Ground, or Weighted Multi-Criteria Score.
        </p>
      </div>
      <Suspense fallback={<TableSkeleton rows={8} />}>
        <LogisticsContent cursor={sp.cursor} />
      </Suspense>
    </div>
  );
}
