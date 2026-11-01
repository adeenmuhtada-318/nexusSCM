"use client";

import * as React from "react";
import { signInAction } from "@/lib/auth/actions";
import { ActionFeedback } from "@/components/ui/action-feedback";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/form-controls";

const DEMO_ACCOUNTS = [
  { role: "ADMIN", email: "admin@nexus.local", desc: "Full access + versioned rule thresholds" },
  { role: "MANAGER", email: "manager@nexus.local", desc: "Approves >= $10k POs, assigns/resolves exceptions" },
  { role: "BUYER", email: "buyer@nexus.local", desc: "Converts requisitions, approves Tier-3 spot POs" },
  { role: "CUSTOMER_SERVICE", email: "cs@nexus.local", desc: "Orders, holds, RMAs, and refunds" },
  { role: "WAREHOUSE_TECH", email: "tech@nexus.local", desc: "Stock receipts, cycle counts, shipping, dock RMA inspection" },
] as const;

export function LoginForm() {
  const [state, formAction, pending] = React.useActionState(signInAction, { error: null });
  const [email, setEmail] = React.useState("manager@nexus.local");
  const [password, setPassword] = React.useState("Nexus123!");
  const [showPassword, setShowPassword] = React.useState(false);

  return (
    <div className="space-y-5">
      <form action={formAction} className="space-y-3">
        <ActionFeedback error={state.error} message={null} />
        <div>
          <Label htmlFor="email">Work Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            spellCheck={false}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <Label htmlFor="password" className="mb-0">
              Password
            </Label>
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="text-[11px] font-medium text-slate-600 underline hover:text-slate-900 cursor-pointer"
            >
              {showPassword ? "Hide password" : "Show password"}
            </button>
          </div>
          <Input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            enterKeyHint="done"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? "Signing in..." : "Sign In"}
        </Button>
      </form>

      <div className="border-t border-slate-200 pt-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Seeded RBAC Accounts (Click to autofill · Password: <code className="font-mono">Nexus123!</code>)
        </p>
        <div className="grid gap-1.5">
          {DEMO_ACCOUNTS.map((acct) => (
            <button
              key={acct.email}
              type="button"
              onClick={() => {
                setEmail(acct.email);
                setPassword("Nexus123!");
              }}
              className="flex items-center justify-between rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-left text-xs hover:border-slate-400 hover:bg-slate-100 cursor-pointer"
            >
              <div>
                <span className="font-mono font-semibold text-slate-900">{acct.role}</span>
                <span className="ml-2 text-slate-500">{acct.desc}</span>
              </div>
              <span className="font-mono text-[11px] text-slate-600">{acct.email}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
