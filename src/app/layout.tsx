import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NexusSCM — HITL Supply Chain Control Tower",
  description: "Management-by-Exception Supply Chain Platform across Inventory, Orders, Logistics, Procurement, and Returns.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
