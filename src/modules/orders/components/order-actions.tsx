"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  cancelOrderAction,
  confirmOrderAction,
  createOrderAction,
  markDeliveredAction,
  releaseHoldAction,
  shipFulfillmentAction,
} from "@/modules/orders/actions";
import { ActionFeedback } from "@/components/ui/action-feedback";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/form-controls";
import { ModalDialog } from "@/components/ui/modal-dialog";

export interface CustomerAddressOption {
  customerId: number;
  name: string;
  addressId: number;
  city: string;
  region: string;
}

export interface OrderSkuOption {
  id: number;
  code: string;
  name: string;
  listPriceCents: number;
}

export function CreateOrderModal({
  customers,
  skus,
}: {
  customers: readonly CustomerAddressOption[];
  skus: readonly OrderSkuOption[];
}) {
  const router = useRouter();
  const [destIdx, setDestIdx] = React.useState("0");
  const [skuId, setSkuId] = React.useState(String(skus[0]?.id ?? ""));
  const [qty, setQty] = React.useState("2");
  const [isCustomized, setIsCustomized] = React.useState(false);
  const [priority, setPriority] = React.useState<"STANDARD" | "URGENT">("STANDARD");
  const [windowDays, setWindowDays] = React.useState("5");
  const [idemKey, setIdemKey] = React.useState(() => `ui-ord-${crypto.randomUUID()}`);
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  return (
    <ModalDialog triggerLabel="+ Place Order" triggerVariant="default" title="Place Customer Order (Seven Rights Gate)">
      {(close) => (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            const dest = customers[Number(destIdx)];
            if (!dest) return;
            startTransition(async () => {
              const res = await createOrderAction({
                customerId: dest.customerId,
                addressId: dest.addressId,
                lines: [{ skuId: Number(skuId), qty: Number(qty), isCustomized }],
                priority,
                deliveryWindowDays: Number(windowDays),
                idempotencyKey: idemKey,
              });
              if (!res.success) {
                setError(res.error);
                return;
              }
              setIdemKey(`ui-ord-${crypto.randomUUID()}`);
              close();
              router.refresh();
            });
          }}
        >
          <ActionFeedback error={error} message={null} />
          <div>
            <Label htmlFor="ord-cust">Customer & Delivery Address</Label>
            <Select id="ord-cust" value={destIdx} onChange={(e) => setDestIdx(e.target.value)}>
              {customers.map((c, idx) => (
                <option key={`${c.customerId}-${c.addressId}`} value={idx}>
                  {c.name} — {c.city}, {c.region} (Addr #{c.addressId})
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ord-sku">SKU (Price recomputed server-side)</Label>
              <Select id="ord-sku" value={skuId} onChange={(e) => setSkuId(e.target.value)}>
                {skus.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="ord-qty">Quantity</Label>
              <Input id="ord-qty" type="number" min={1} required value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ord-prio">Priority</Label>
              <Select id="ord-prio" value={priority} onChange={(e) => setPriority(e.target.value === "URGENT" ? "URGENT" : "STANDARD")}>
                <option value="STANDARD">STANDARD</option>
                <option value="URGENT">URGENT (Air Express rule)</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="ord-win">Delivery Window (days)</Label>
              <Input id="ord-win" type="number" min={1} max={60} required value={windowDays} onChange={(e) => setWindowDays(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input type="checkbox" checked={isCustomized} onChange={(e) => setIsCustomized(e.target.checked)} />
            Customized / Built-to-order item (non-returnable per §5.5)
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Evaluating..." : "Submit Order"}
            </Button>
          </div>
        </form>
      )}
    </ModalDialog>
  );
}

export function OrderRowActions({ orderId, status }: { orderId: number; status: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [err, setErr] = React.useState<string | null>(null);

  const run = (fn: () => Promise<{ success: boolean; error?: string }>) => {
    setErr(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.success) setErr(r.error ?? "Action failed");
      else router.refresh();
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {status === "RESERVED" && (
        <Button size="sm" variant="success" disabled={pending} onClick={() => run(() => confirmOrderAction({ orderId }))}>
          Confirm
        </Button>
      )}
      {(status === "ON_HOLD_EXCEPTION" || status === "BACKORDERED") && (
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => releaseHoldAction({ orderId }))}>
          Re-evaluate Hold
        </Button>
      )}
      {["RESERVED", "CONFIRMED", "ON_HOLD_EXCEPTION", "BACKORDERED"].includes(status) && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => run(() => cancelOrderAction({ orderId, reason: "OPERATOR_CANCELLED" }))}
        >
          Cancel
        </Button>
      )}
      {err && <span className="text-[11px] text-red-600">{err}</span>}
    </div>
  );
}

export function FulfillmentRowActions({
  fulfillmentId,
  orderStatus,
  fulfillmentStatus,
}: {
  fulfillmentId: number;
  orderStatus: string;
  fulfillmentStatus: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [msg, setMsg] = React.useState<string | null>(null);

  const canShip = fulfillmentStatus === "RESERVED" && (orderStatus === "CONFIRMED" || orderStatus === "PARTIALLY_SHIPPED");
  const canDeliver = fulfillmentStatus === "SHIPPED";

  return (
    <div className="flex items-center gap-1.5">
      {canShip && (
        <Button
          size="sm"
          disabled={pending}
          onClick={() => {
            setMsg(null);
            startTransition(async () => {
              const r = await shipFulfillmentAction({ fulfillmentId });
              if (!r.success) setMsg(r.error);
              else if (!r.data.shipped) setMsg(`Queued exception #${r.data.exceptionId}: ${r.data.reason}`);
              else router.refresh();
            });
          }}
        >
          Book & Ship
        </Button>
      )}
      {canDeliver && (
        <Button
          size="sm"
          variant="success"
          disabled={pending}
          onClick={() => {
            setMsg(null);
            startTransition(async () => {
              const r = await markDeliveredAction({ fulfillmentId });
              if (!r.success) setMsg(r.error);
              else router.refresh();
            });
          }}
        >
          Mark Delivered
        </Button>
      )}
      {msg && <span className="text-[11px] text-amber-700">{msg}</span>}
    </div>
  );
}
