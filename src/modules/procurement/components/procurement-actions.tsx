"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  approvePoAction,
  createPoAction,
  receivePoAction,
  rejectPoAction,
  runReplenishmentAction,
} from "@/modules/procurement/actions";
import { ActionFeedback } from "@/components/ui/action-feedback";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/form-controls";
import { ModalDialog } from "@/components/ui/modal-dialog";

export function RunReplenishmentButton() {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [note, setNote] = React.useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => {
          setNote(null);
          startTransition(async () => {
            const res = await runReplenishmentAction({});
            if (!res.success) setNote(res.error);
            else {
              setNote(`Requisitions: +${res.data.created}, POs: +${res.data.converted}`);
              router.refresh();
            }
          });
        }}
      >
        {pending ? "Scanning ROP..." : "Run Auto-Replenishment"}
      </Button>
      {note && <span className="text-xs text-slate-600">{note}</span>}
    </div>
  );
}

export function ConvertRequisitionButton({ requisitionId }: { requisitionId: number }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [err, setErr] = React.useState<string | null>(null);

  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="sm"
        disabled={pending}
        onClick={() => {
          setErr(null);
          startTransition(async () => {
            const res = await createPoAction({ requisitionId, idempotencyKey: `ui-req-${requisitionId}` });
            if (!res.success) setErr(res.error);
            else router.refresh();
          });
        }}
      >
        Convert to PO
      </Button>
      {err && <span className="text-[11px] text-red-600">{err}</span>}
    </div>
  );
}

export function PoRowActions({
  poId,
  status,
  warehouses,
}: {
  poId: number;
  status: string;
  warehouses: readonly { id: number; code: string; name: string }[];
}) {
  const router = useRouter();
  const [reasonCode, setReasonCode] = React.useState("BUDGET_VERIFIED");
  const [warehouseId, setWarehouseId] = React.useState(String(warehouses[0]?.id ?? ""));
  const [lotCode, setLotCode] = React.useState(`PO-${poId}-LOT`);
  const [expiryDate, setExpiryDate] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const needsApproval = status === "PENDING_BUYER_APPROVAL" || status === "PENDING_MANAGER_APPROVAL";

  return (
    <div className="flex items-center gap-1.5">
      {needsApproval && (
        <ModalDialog triggerLabel="Review PO" triggerVariant="default" title={`Approve / Reject PO #${poId}`}>
          {(close) => (
            <div className="space-y-3">
              <ActionFeedback error={error} message={null} />
              <div>
                <Label htmlFor={`po-rc-${poId}`}>Mandatory Approval / Rejection Reason Code</Label>
                <Input id={`po-rc-${poId}`} required minLength={3} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    startTransition(async () => {
                      const r = await rejectPoAction({ poId, reasonCode });
                      if (!r.success) setError(r.error);
                      else {
                        close();
                        router.refresh();
                      }
                    });
                  }}
                >
                  Reject
                </Button>
                <Button
                  type="button"
                  variant="success"
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    startTransition(async () => {
                      const r = await approvePoAction({ poId, reasonCode, idempotencyKey: `ui-ap-po-${poId}` });
                      if (!r.success) setError(r.error);
                      else {
                        close();
                        router.refresh();
                      }
                    });
                  }}
                >
                  Approve & Dispatch
                </Button>
              </div>
            </div>
          )}
        </ModalDialog>
      )}

      {status === "APPROVED_AND_DISPATCHED" && warehouses.length > 0 && (
        <ModalDialog triggerLabel="Receive Goods" triggerVariant="secondary" title={`Receive PO #${poId} into Warehouse`}>
          {(close) => (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                startTransition(async () => {
                  const r = await receivePoAction({
                    poId,
                    warehouseId: Number(warehouseId),
                    lotCode,
                    expiryDate: expiryDate ? expiryDate : null,
                  });
                  if (!r.success) setError(r.error);
                  else {
                    close();
                    router.refresh();
                  }
                });
              }}
            >
              <ActionFeedback error={error} message={null} />
              <div>
                <Label htmlFor={`po-wh-${poId}`}>Receiving Warehouse</Label>
                <Select id={`po-wh-${poId}`} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} — {w.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor={`po-lot-${poId}`}>Lot Prefix</Label>
                  <Input id={`po-lot-${poId}`} required value={lotCode} onChange={(e) => setLotCode(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor={`po-exp-${poId}`}>Expiry Date (if perishable)</Label>
                  <Input id={`po-exp-${poId}`} type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? "Receiving..." : "Confirm Receipt"}
                </Button>
              </div>
            </form>
          )}
        </ModalDialog>
      )}
    </div>
  );
}
