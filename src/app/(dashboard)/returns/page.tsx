import { Suspense } from "react";
import Link from "next/link";
import { getWarehouseOptions } from "@/modules/inventory/queries";
import { getDeliveredOrderLinesForRma } from "@/modules/orders/queries";
import { getRmaLinesMap, getRmas } from "@/modules/returns/queries";
import { RequestRmaModal, RmaRowActions } from "@/modules/returns/components/returns-actions";
import { Badge, statusBadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableSkeleton } from "@/components/ui/skeleton";
import { DataTable, RowTh, Td, Th, THead } from "@/components/ui/table";

async function ReturnsContent({ cursor }: { cursor: string | undefined }) {
  const [rmasPage, deliveredLines, warehouses] = await Promise.all([
    getRmas(cursor, 25),
    getDeliveredOrderLinesForRma(50),
    getWarehouseOptions(),
  ]);
  const linesMap = await getRmaLinesMap(rmasPage.rows.map((r) => r.id));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-600">
          30-day business-timezone window · Customized items auto-denied · Unopened VERIFIED_NEW restocks PRIME; opened/damaged routes to QUARANTINE_REFURBISHMENT + RETURN_GRADING.
        </p>
        <RequestRmaModal lines={deliveredLines} />
      </div>

      <Card className="panel-contain">
        <CardHeader>
          <CardTitle>Return Merchandise Authorizations (RMAs)</CardTitle>
          {cursor && (
            <Link href="/returns" className="text-xs font-medium text-slate-700 underline">
              ← First Page
            </Link>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {rmasPage.rows.length === 0 ? (
            <p className="p-6 text-center text-xs text-slate-500">No RMAs requested yet.</p>
          ) : (
            <DataTable label="RMAs" className="border-0 rounded-none">
              <THead>
                <tr>
                  <Th>RMA Number</Th>
                  <Th>Order ID</Th>
                  <Th>Status</Th>
                  <Th>Reason Code</Th>
                  <Th>Requested</Th>
                  <Th>Workflow Action</Th>
                </tr>
              </THead>
              <tbody>
                {rmasPage.rows.map((r) => (
                  <tr key={r.id}>
                    <RowTh>{r.rmaNumber}</RowTh>
                    <Td label="Order" className="font-mono text-[11px]">
                      Order #{r.orderId}
                    </Td>
                    <Td label="Status">
                      <Badge variant={statusBadgeVariant(r.status)}>{r.status}</Badge>
                    </Td>
                    <Td label="Reason">{r.reasonCode}</Td>
                    <Td label="Requested" className="font-mono text-[11px]">
                      {r.requestedAt.toISOString().slice(0, 10)}
                    </Td>
                    <Td label="Action">
                      <RmaRowActions
                        rmaId={r.id}
                        status={r.status}
                        rmaLineIds={linesMap.get(r.id) ?? []}
                        warehouses={warehouses}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
          {rmasPage.nextCursor && (
            <div className="flex justify-end border-t border-slate-100 px-4 py-2.5">
              <Button asChild size="sm" variant="outline">
                <Link href={`/returns?cursor=${encodeURIComponent(rmasPage.nextCursor)}`}>Next Page →</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default async function ReturnsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const sp = await searchParams;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-slate-900">Returns, Dock Inspection & Refunds</h1>
        <p className="text-xs text-slate-500">
          Concurrency-safe anti-double-return claim on order lines, physical dock disposition by returned quantity, and idempotent account-credit refunds.
        </p>
      </div>
      <Suspense fallback={<TableSkeleton rows={8} />}>
        <ReturnsContent cursor={sp.cursor} />
      </Suspense>
    </div>
  );
}
