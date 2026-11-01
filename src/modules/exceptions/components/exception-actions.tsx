"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { assignExceptionAction, resolveExceptionAction } from "@/modules/exceptions/actions";
import { ActionFeedback } from "@/components/ui/action-feedback";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/form-controls";
import { ModalDialog } from "@/components/ui/modal-dialog";

export interface AssignableUser {
  id: string;
  name: string;
  role: string;
}

export function ExceptionRowActions({
  exceptionId,
  users,
}: {
  exceptionId: number;
  users: readonly AssignableUser[];
}) {
  const router = useRouter();
  const [resolution, setResolution] = React.useState<"RESOLVED" | "DISMISSED">("RESOLVED");
  const [note, setNote] = React.useState("");
  const [assigneeId, setAssigneeId] = React.useState(users[0]?.id ?? "");
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  return (
    <div className="flex items-center gap-1.5">
      <ModalDialog triggerLabel="Resolve" triggerVariant="default" title={`Resolve Exception #${exceptionId}`}>
        {(close) => (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              startTransition(async () => {
                const res = await resolveExceptionAction({ id: exceptionId, resolution, note });
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
              <Label htmlFor={`res-mode-${exceptionId}`}>Outcome</Label>
              <Select
                id={`res-mode-${exceptionId}`}
                value={resolution}
                onChange={(e) => setResolution(e.target.value === "DISMISSED" ? "DISMISSED" : "RESOLVED")}
              >
                <option value="RESOLVED">RESOLVED — Issue remediated</option>
                <option value="DISMISSED">DISMISSED — False positive / superseded</option>
              </Select>
            </div>
            <div>
              <Label htmlFor={`res-note-${exceptionId}`}>Audit Resolution Note (min 3 chars)</Label>
              <Input
                id={`res-note-${exceptionId}`}
                required
                minLength={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Credit limit raised after controller sign-off"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving..." : "Confirm"}
              </Button>
            </div>
          </form>
        )}
      </ModalDialog>

      {users.length > 0 && (
        <ModalDialog triggerLabel="Assign" triggerVariant="outline" title={`Assign Exception #${exceptionId}`}>
          {(close) => (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                startTransition(async () => {
                  const res = await assignExceptionAction({ id: exceptionId, assigneeId });
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
                <Label htmlFor={`asg-${exceptionId}`}>Operator</Label>
                <Select id={`asg-${exceptionId}`} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.role})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? "Assigning..." : "Assign"}
                </Button>
              </div>
            </form>
          )}
        </ModalDialog>
      )}
    </div>
  );
}
