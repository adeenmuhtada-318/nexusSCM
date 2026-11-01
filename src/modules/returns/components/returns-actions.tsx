"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  receiveAndInspectRmaAction,
  refundRmaAction,
  requestRmaAction,
  reviewRmaAction,
} from "@/modules/returns/actions";
import { ActionFeedback } from "@/components/ui/action-feedback";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/form-controls";
import { ModalDialog } from "@/components/ui/modal-dialog";

export interface DeliveredOrderLineOption {
  orderLineId: number;
  orderId: number;
  orderNumber: string;
  skuCode: string;
  qty: number;
  qtyReturned: number;
  isCustomized: boolean;
}

export function RequestRmaModal({ lines }: { lines: readonly DeliveredOrderLineOption[] }) {
  const router = useRouter();
  const [lineIdx, setLineIdx] = React.useState("0");
  const [qty, setQty] = React.useState("1");
  const [reasonCode, setReasonCode] = React.useState("DEFECTIVE_UNIT");
  const [idemKey, setIdemKey] = React.useState(() => `ui-rma-${crypto.randomUUID()}`);
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  if (lines.length === 0) return null;

  return (
    <ModalDialog triggerLabel="+ Request RMA" triggerVariant="default" title="Request Return Merchandise Authorization">
      {(close) => (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            const chosen = lines[Number(lineIdx)];
            if (!chosen) return;
            startTransition(async () => {
              const res = await requestRmaAction({
                orderId: chosen.orderId,
                lines: [{ orderLineId: chosen.orderLineId, qty: Number(qty) }],
                reasonCode,
                idempotencyKey: idemKey,
              });
              if (!res.success) {
                setError(res.error);
                return;
              }
              setIdemKey(`ui-rma-${crypto.randomUUID()}`);
              close();
              router.refresh();
            });
          }}
        >
          <ActionFeedback error={error} message={null} />
          <div>
            <Label htmlFor="rma-line">Delivered Order Line</Label>
            <Select id="rma-line" value={lineIdx} onChange={(e) => setLineIdx(e.target.value)}>
              {lines.map((l, i) => (
                <option key={l.orderLineId} value={i}>
                  {l.orderNumber} · {l.skuCode} (Ordered {l.qty}, Returned {l.qtyReturned}
                  {l.isCustomized ? ", Customized" : ""})
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="rma-qty">Return Qty</Label>
              <Input id="rma-qty" type="number" min={1} required value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="rma-rc">Reason Code</Label>
              <Input id="rma-rc" required minLength={2} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Evaluating..." : "Submit RMA"}
            </Button>
          </div>
        </form>
      )}
    </ModalDialog>
  );
}

export function RmaRowActions({
  rmaId,
  status,
  rmaLineIds,
  warehouses,
}: {
  rmaId: number;
  status: string;
  rmaLineIds: readonly number[];
  warehouses: readonly { id: number; code: string; name: string }[];
}) {
  const router = useRouter();
  const [note, setNote] = React.useState("Verified customer claim");
  const [warehouseId, setWarehouseId] = React.useState(String(warehouses[0]?.id ?? ""));
  const [isOpened, setIsOpened] = React.useState(false);
  const [condition, setCondition] = React.useState<"VERIFIED_NEW" | "OPENED_GOOD" | "DAMAGED">("VERIFIED_NEW");
  const [expiryDate, setExpiryDate] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  return (
    <div className="flex items-center gap-1.5">
      {status === "PENDING_REVIEW" && (
        <ModalDialog triggerLabel="Review" triggerVariant="default" title={`Review RMA #${rmaId}`}>
          {(close) => (
            <div className="space-y-3">
              <ActionFeedback error={error} message={null} />
              <div>
                <Label htmlFor={`rma-note-${rmaId}`}>Review Note (Reviewer ≠ Requester)</Label>
                <Input id={`rma-note-${rmaId}`} required minLength={3} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    startTransition(async () => {
                      const r = await reviewRmaAction({ rmaId, decision: "DENY", note });
                      if (!r.success) setError(r.error);
                      else {
                        close();
                        router.refresh();
                      }
                    });
                  }}
                >
                  Deny
                </Button>
                <Button
                  type="button"
                  variant="success"
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    startTransition(async () => {
                      const r = await reviewRmaAction({ rmaId, decision: "APPROVE", note });
                      if (!r.success) setError(r.error);
                      else {
                        close();
                        router.refresh();
                      }
                    });
                  }}
                >
                  Approve
                </Button>
              </div>
            </div>
          )}
        </ModalDialog>
      )}

      {status === "APPROVED" && warehouses.length > 0 && rmaLineIds.length > 0 && (
        <ModalDialog triggerLabel="Dock Inspect" triggerVariant="secondary" title={`Dock Receipt & Inspection — RMA #${rmaId}`}>
          {(close) => (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                startTransition(async () => {
                  const r = await receiveAndInspectRmaAction({
                    rmaId,
                    warehouseId: Number(warehouseId),
                    lines: rmaLineIds.map((id) => ({
                      rmaLineId: id,
                      isOpened,
                      condition,
                      expiryDate: expiryDate ? expiryDate : null,
                    })),
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
                <Label htmlFor={`rma-wh-${rmaId}`}>Dock Warehouse</Label>
                <Select id={`rma-wh-${rmaId}`} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} — {w.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor={`rma-cond-${rmaId}`}>Physical Condition</Label>
                  <Select
                    id={`rma-cond-${rmaId}`}
                    value={condition}
                    onChange={(e) =>
                      setCondition(e.target.value === "DAMAGED" ? "DAMAGED" : e.target.value === "OPENED_GOOD" ? "OPENED_GOOD" : "VERIFIED_NEW")
                    }
                  >
                    <option value="VERIFIED_NEW">VERIFIED_NEW</option>
                    <option value="OPENED_GOOD">OPENED_GOOD</option>
                    <option value="DAMAGED">DAMAGED</option>
                  </Select>
                </div>
                <div>
                  <Label htmlFor={`rma-exp-${rmaId}`}>Expiry Date (if perishable PRIME)</Label>
                  <Input id={`rma-exp-${rmaId}`} type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-700">
                <input type="checkbox" checked={isOpened} onChange={(e) => setIsOpened(e.target.checked)} />
                Seal broken / package opened (routes to QUARANTINE_REFURBISHMENT + RETURN_GRADING)
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? "Inspecting..." : "Complete Inspection"}
                </Button>
              </div>
            </form>
          )}
        </ModalDialog>
      )}

      {status === "INSPECTED" && (
        <Button
          size="sm"
          variant="success"
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const r = await refundRmaAction({ rmaId, idempotencyKey: `ui-ref-rma-${rmaId}` });
              if (!r.success) setError(r.error);
              else router.refresh();
            });
          }}
        >
          Issue Refund
        </Button>
      )}
      {error && status === "INSPECTED" && <span className="text-[11px] text-red-600">{error}</span>}
    </div>
  );
}
