import { Suspense } from "react";
import Link from "next/link";
import { getActiveSkus } from "@/modules/inventory/queries";
import { getCustomerPickerOptions, getOrders, getRecentFulfillments } from "@/modules/orders/queries";
import { CreateOrderModal, FulfillmentRowActions, OrderRowActions } from "@/modules/orders/components/order-actions";
import { Badge, statusBadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableSkeleton } from "@/components/ui/skeleton";
import { DataTable, RowTh, Td, Th, THead } from "@/components/ui/table";
import { formatMoney } from "@/lib/utils/money";

async function OrdersContent({ cursor }: { cursor: string | undefined }) {
  const [ordersPage, fulfillments, customers, skus] = await Promise.all([
    getOrders(cursor, 25),
    getRecentFulfillments(30),
    getCustomerPickerOptions(),
    getActiveSkus(),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-600">
          Prices recomputed server-side (contract price overrides list). Unconfirmed reservations expire automatically after 30m TTL.
        </p>
        <CreateOrderModal customers={customers} skus={skus} />
      </div>

      <Card className="panel-contain">
        <CardHeader>
          <CardTitle>Customer Orders</CardTitle>
          {cursor && (
            <Link href="/orders" className="text-xs font-medium text-slate-700 underline">
              ← First Page
            </Link>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {ordersPage.rows.length === 0 ? (
            <p className="p-6 text-center text-xs text-slate-500">No orders placed yet.</p>
          ) : (
            <DataTable label="Customer orders" className="border-0 rounded-none">
              <THead>
                <tr>
                  <Th>Order</Th>
                  <Th>Customer</Th>
                  <Th>Status</Th>
                  <Th>Hold Reason</Th>
                  <Th>Total (USD)</Th>
                  <Th>Reservation TTL</Th>
                  <Th>Actions</Th>
                </tr>
              </THead>
              <tbody>
                {ordersPage.rows.map((o) => (
                  <tr key={o.id}>
                    <RowTh>{o.orderNumber}</RowTh>
                    <Td label="Customer">{o.customerName}</Td>
                    <Td label="Status">
                      <Badge variant={statusBadgeVariant(o.status)}>{o.status}</Badge>
                    </Td>
                    <Td label="Hold Reason" className="font-mono text-[11px]">
                      {o.holdReasonCode ?? "—"}
                    </Td>
                    <Td label="Total" className="font-mono tabular-nums font-medium">
                      {formatMoney(o.totalCents)}
                    </Td>
                    <Td label="TTL" className="font-mono text-[11px] tabular-nums">
                      {o.reservationExpiresAt ? o.reservationExpiresAt.toISOString().slice(11, 19) + "Z" : "—"}
                    </Td>
                    <Td label="Actions">
                      <OrderRowActions orderId={o.id} status={o.status} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
          {ordersPage.nextCursor && (
            <div className="flex justify-end border-t border-slate-100 px-4 py-2.5">
              <Button asChild size="sm" variant="outline">
                <Link href={`/orders?cursor=${encodeURIComponent(ordersPage.nextCursor)}`}>Next Page →</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="panel-contain">
        <CardHeader>
          <CardTitle>Warehouse Fulfillment Splits (Haversine Ranked)</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {fulfillments.length === 0 ? (
            <p className="p-4 text-xs text-slate-500">No fulfillment splits allocated yet.</p>
          ) : (
            <DataTable label="Child fulfillment orders" className="border-0 rounded-none">
              <THead>
                <tr>
                  <Th>Fulfillment</Th>
                  <Th>Parent Order</Th>
                  <Th>Warehouse</Th>
                  <Th>Status</Th>
                  <Th>Shipped / Delivered</Th>
                  <Th>Dock Action</Th>
                </tr>
              </THead>
              <tbody>
                {fulfillments.map((f) => (
                  <tr key={f.id}>
                    <RowTh>FO-{f.id}</RowTh>
                    <Td label="Parent Order" className="font-mono text-[11px]">
                      {f.orderNumber} ({f.orderStatus})
                    </Td>
                    <Td label="Warehouse" className="font-mono text-[11px]">
                      {f.warehouseCode}
                    </Td>
                    <Td label="Status">
                      <Badge variant={statusBadgeVariant(f.status)}>{f.status}</Badge>
                    </Td>
                    <Td label="Timestamps" className="font-mono text-[11px]">
                      {f.deliveredAt
                        ? `Deliv ${f.deliveredAt.toISOString().slice(0, 10)}`
                        : f.shippedAt
                          ? `Ship ${f.shippedAt.toISOString().slice(0, 10)}`
                          : "Awaiting dispatch"}
                    </Td>
                    <Td label="Dock Action">
                      <FulfillmentRowActions fulfillmentId={f.id} orderStatus={f.orderStatus} fulfillmentStatus={f.status} />
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

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const sp = await searchParams;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-slate-900">Orders, Seven Rights Validation & Fulfillments</h1>
        <p className="text-xs text-slate-500">
          Validates customer/account status, geocoded address, hazmat restrictions, credit limit, and warehouse FEFO/FIFO availability in one ACID transaction.
        </p>
      </div>
      <Suspense fallback={<TableSkeleton rows={8} />}>
        <OrdersContent cursor={sp.cursor} />
      </Suspense>
    </div>
  );
}
