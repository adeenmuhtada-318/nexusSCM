import { Suspense } from "react";
import Link from "next/link";
import { getAssignableUsers, getOpenExceptionCounts, getOpenExceptions } from "@/modules/exceptions/queries";
import { ExceptionRowActions } from "@/modules/exceptions/components/exception-actions";
import { Badge, statusBadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableSkeleton } from "@/components/ui/skeleton";
import { DataTable, RowTh, Td, Th, THead } from "@/components/ui/table";

async function ExceptionQueueTable({ cursor }: { cursor: string | undefined }) {
  const [page, counts, users] = await Promise.all([getOpenExceptions(cursor, 25), getOpenExceptionCounts(), getAssignableUsers()]);

  return (
    <Card className="panel-contain">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Open & In-Review Exceptions ({counts.open})</CardTitle>
          {counts.overdue > 0 && <Badge variant="critical">{counts.overdue} Overdue</Badge>}
        </div>
        {cursor && (
          <Link href="/exceptions" className="text-xs font-medium text-slate-700 underline">
            ← First Page
          </Link>
        )}
      </CardHeader>
      <CardContent className="space-y-3 p-0">
        {page.rows.length === 0 ? (
          <p className="p-6 text-center text-xs text-slate-500">All exceptions resolved. Queue is clear.</p>
        ) : (
          <DataTable label="Exception queue" className="border-0 rounded-none">
            <THead>
              <tr>
                <Th>ID</Th>
                <Th>Severity</Th>
                <Th>Status</Th>
                <Th>Type</Th>
                <Th>Entity</Th>
                <Th>Reason Code</Th>
                <Th>SLA Due (UTC)</Th>
                <Th>Actions</Th>
              </tr>
            </THead>
            <tbody>
              {page.rows.map((ex) => {
                const assignee = users.find((u) => u.id === ex.assignedTo);
                return (
                  <tr key={ex.id}>
                    <RowTh>#{ex.id}</RowTh>
                    <Td label="Severity">
                      <Badge variant={statusBadgeVariant(ex.severity)}>{ex.severity}</Badge>
                    </Td>
                    <Td label="Status">
                      <Badge variant={statusBadgeVariant(ex.status)}>{ex.status}</Badge>
                      {assignee && <div className="mt-0.5 text-[10px] text-slate-500">{assignee.name}</div>}
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
                    <Td label="Actions">
                      <ExceptionRowActions exceptionId={ex.id} users={users} />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
        {page.nextCursor && (
          <div className="flex justify-end border-t border-slate-100 px-4 py-2.5">
            <Button asChild size="sm" variant="outline">
              <Link href={`/exceptions?cursor=${encodeURIComponent(page.nextCursor)}`}>Next Page →</Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const sp = await searchParams;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-slate-900">HITL Exception Queue</h1>
        <p className="text-xs text-slate-500">
          Ordered by SLA deadline (`due_at ASC, id ASC`). Enforces role-per-exception-type and separation of duties (`resolver ≠ requester`).
        </p>
      </div>
      <Suspense fallback={<TableSkeleton rows={8} />}>
        <ExceptionQueueTable cursor={sp.cursor} />
      </Suspense>
    </div>
  );
}
