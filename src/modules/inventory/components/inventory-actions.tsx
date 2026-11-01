"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { adjustStockAction, receiveStockAction } from "@/modules/inventory/actions";
import { ActionFeedback } from "@/components/ui/action-feedback";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/form-controls";
import { ModalDialog } from "@/components/ui/modal-dialog";

export interface SkuPickerOption {
  id: number;
  code: string;
  name: string;
  isPerishable: boolean;
}

export interface WarehousePickerOption {
  id: number;
  code: string;
  name: string;
}

export function ReceiveStockModal({
  skus,
  warehouses,
}: {
  skus: readonly SkuPickerOption[];
  warehouses: readonly WarehousePickerOption[];
}) {
  const router = useRouter();
  const [skuId, setSkuId] = React.useState(String(skus[0]?.id ?? ""));
  const [warehouseId, setWarehouseId] = React.useState(String(warehouses[0]?.id ?? ""));
  const [qty, setQty] = React.useState("25");
  const [zone, setZone] = React.useState<"PRIME" | "QUARANTINE_QUALITY" | "QUARANTINE_REFURBISHMENT">("PRIME");
  const [lotCode, setLotCode] = React.useState("LOT-RCV-100");
  const [expiryDate, setExpiryDate] = React.useState("");
  const [reasonCode, setReasonCode] = React.useState("DOCK_RECEIPT");
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const selectedSku = skus.find((s) => String(s.id) === skuId);

  return (
    <ModalDialog triggerLabel="+ Receive Stock" triggerVariant="default" title="Receive Inventory Batch">
      {(close) => (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            startTransition(async () => {
              const res = await receiveStockAction({
                skuId: Number(skuId),
                warehouseId: Number(warehouseId),
                qty: Number(qty),
                zone,
                lotCode,
                expiryDate: expiryDate ? expiryDate : null,
                reasonCode,
              });
              if (!res.success) {
                setError(res.error);
                return;
              }
              close();
              router.refresh();
            });
          }}
        >
          <ActionFeedback error={error} message={null} />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="rcv-sku">SKU</Label>
              <Select id="rcv-sku" value={skuId} onChange={(e) => setSkuId(e.target.value)}>
                {skus.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="rcv-wh">Warehouse</Label>
              <Select id="rcv-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} — {w.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="rcv-qty">Quantity</Label>
              <Input id="rcv-qty" type="number" min={1} required value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="rcv-zone">Zone Status</Label>
              <Select
                id="rcv-zone"
                value={zone}
                onChange={(e) =>
                  setZone(
                    e.target.value === "QUARANTINE_QUALITY"
                      ? "QUARANTINE_QUALITY"
                      : e.target.value === "QUARANTINE_REFURBISHMENT"
                        ? "QUARANTINE_REFURBISHMENT"
                        : "PRIME",
                  )
                }
              >
                <option value="PRIME">PRIME (Allocatable)</option>
                <option value="QUARANTINE_QUALITY">QUARANTINE_QUALITY</option>
                <option value="QUARANTINE_REFURBISHMENT">QUARANTINE_REFURBISHMENT</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="rcv-lot">Lot Code</Label>
              <Input id="rcv-lot" required value={lotCode} onChange={(e) => setLotCode(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="rcv-exp">Expiry Date {selectedSku?.isPerishable ? "(Required)" : "(Optional)"}</Label>
              <Input
                id="rcv-exp"
                type="date"
                required={Boolean(selectedSku?.isPerishable)}
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="rcv-reason">Reason Code</Label>
            <Input id="rcv-reason" required minLength={2} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Posting..." : "Post Receipt"}
            </Button>
          </div>
        </form>
      )}
    </ModalDialog>
  );
}

export function AdjustBatchModal({ batchId, lotCode }: { batchId: number; lotCode: string }) {
  const router = useRouter();
  const [delta, setDelta] = React.useState("-1");
  const [reasonCode, setReasonCode] = React.useState("CYCLE_COUNT_VARIANCE");
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  return (
    <ModalDialog triggerLabel="Adjust" triggerVariant="outline" title={`Cycle-Count Adjust Batch #${batchId} (${lotCode})`}>
      {(close) => (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            startTransition(async () => {
              const res = await adjustStockAction({ batchId, delta: Number(delta), reasonCode });
              if (!res.success) {
                setError(res.error);
                return;
              }
              close();
              router.refresh();
            });
          }}
        >
          <ActionFeedback error={error} message={null} />
          <div>
            <Label htmlFor={`adj-delta-${batchId}`}>Signed Delta (non-zero; appends compensating ledger entry)</Label>
            <Input id={`adj-delta-${batchId}`} type="number" required value={delta} onChange={(e) => setDelta(e.target.value)} />
          </div>
          <div>
            <Label htmlFor={`adj-reason-${batchId}`}>Reason Code</Label>
            <Input id={`adj-reason-${batchId}`} required minLength={2} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Recording..." : "Record Adjustment"}
            </Button>
          </div>
        </form>
      )}
    </ModalDialog>
  );
}
