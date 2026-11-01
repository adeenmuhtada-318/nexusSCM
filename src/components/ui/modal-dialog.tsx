"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button, type ButtonProps } from "./button";

/**
 * Accessible native `<dialog>` modal with declarative `closedby="any"` light-dismiss and a bounding-box backdrop
 * fallback for browsers (e.g. Safari) where `HTMLDialogElement.prototype.closedBy` is not yet supported.
 */
export function ModalDialog({
  triggerLabel,
  triggerVariant = "default",
  triggerSize = "sm",
  title,
  children,
}: {
  triggerLabel: string;
  triggerVariant?: ButtonProps["variant"];
  triggerSize?: ButtonProps["size"];
  title: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || "closedBy" in HTMLDialogElement.prototype) return;
    const onClick = (event: MouseEvent) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!inside) dialog.close();
    };
    dialog.addEventListener("click", onClick);
    return () => dialog.removeEventListener("click", onClick);
  }, []);

  const open = () => dialogRef.current?.showModal();
  const close = () => dialogRef.current?.close();
  const closedByAttr: Record<string, string> = { closedby: "any" };

  return (
    <>
      <Button type="button" variant={triggerVariant} size={triggerSize} onClick={open}>
        {triggerLabel}
      </Button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        {...closedByAttr}
        className="m-auto w-full max-w-lg rounded-lg border border-slate-200 bg-white p-0 text-slate-900 shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3 id={titleId} className="text-sm font-semibold text-slate-900">
            {title}
          </h3>
          <button
            type="button"
            onClick={close}
            aria-label="Close dialog"
            className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4">{children(close)}</div>
      </dialog>
    </>
  );
}
