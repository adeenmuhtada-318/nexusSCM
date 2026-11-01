import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import {
  addresses,
  carriers,
  contractPrices,
  customerAccounts,
  customers,
  skus,
  users,
  vendorContracts,
  vendors,
  warehouses,
} from "@/lib/db/schema";
import type { Role } from "@/lib/auth/roles";

/** Unique suffix so tests sharing one database never collide on unique columns. */
export const uid = (): string => randomUUID().slice(0, 8);

export async function makeUser(role: Role): Promise<{ id: string; role: Role }> {
  const rows = await getDb()
    .insert(users)
    .values({ email: `${role.toLowerCase()}-${uid()}@test.local`, name: `${role} test`, passwordHash: "x", role })
    .returning({ id: users.id });
  const row = rows[0];
  if (!row) throw new Error("user insert failed");
  return { id: row.id, role };
}

export async function makeWarehouse(lat: number, lng: number, code = `WH-${uid()}`): Promise<number> {
  const rows = await getDb().insert(warehouses).values({ code, name: code, lat, lng }).returning({ id: warehouses.id });
  const row = rows[0];
  if (!row) throw new Error("warehouse insert failed");
  return row.id;
}

export async function makeSku(o: Partial<{ perishable: boolean; shelfLifeDays: number; hazmat: boolean; weightLbs: string; priceCents: number; active: boolean; lead: string }> = {}): Promise<number> {
  const code = `SKU-${uid()}`;
  const rows = await getDb()
    .insert(skus)
    .values({
      code,
      name: code,
      category: "general",
      active: o.active ?? true,
      isPerishable: o.perishable ?? false,
      shelfLifeDays: o.perishable ? (o.shelfLifeDays ?? 100) : null,
      isHazmat: o.hazmat ?? false,
      weightLbs: o.weightLbs ?? "2.00",
      maxDimensionIn: "12.00",
      listPriceCents: o.priceCents ?? 1000,
      leadTimeDaysAvg: o.lead ?? "7",
    })
    .returning({ id: skus.id });
  const row = rows[0];
  if (!row) throw new Error("sku insert failed");
  return row.id;
}

export async function makeAccount(creditLimitCents: number, balance = 0): Promise<{ accountId: number; customerId: number; addressId: number }> {
  const db = getDb();
  const acc = await db
    .insert(customerAccounts)
    .values({ name: `Acct ${uid()}`, creditLimitCents, currentBalanceCents: balance })
    .returning({ id: customerAccounts.id });
  const accountId = acc[0]?.id;
  if (accountId === undefined) throw new Error("account insert failed");
  const cust = await db
    .insert(customers)
    .values({ accountId, name: "Cust", email: `c-${uid()}@test.local` })
    .returning({ id: customers.id });
  const customerId = cust[0]?.id;
  if (customerId === undefined) throw new Error("customer insert failed");
  const addr = await db
    .insert(addresses)
    .values({ customerId, line1: "1 Main", city: "New York", region: "NY", postalCode: "10001", lat: 40.7128, lng: -74.006 })
    .returning({ id: addresses.id });
  const addressId = addr[0]?.id;
  if (addressId === undefined) throw new Error("address insert failed");
  return { accountId, customerId, addressId };
}

export async function makeContractPrice(accountId: number, skuId: number, priceCents: number): Promise<void> {
  await getDb().insert(contractPrices).values({ accountId, skuId, priceCents });
}

export async function makeCarrier(o: { mode: "AIR_EXPRESS" | "GROUND_FREIGHT" | "PARCEL"; hazmat?: boolean; maxWeight?: string; transit?: number; base?: number; perLb?: number; reliability?: string; maxDim?: string }): Promise<number> {
  const code = `CAR-${uid()}`;
  const rows = await getDb()
    .insert(carriers)
    .values({
      code,
      name: code,
      mode: o.mode,
      hazmatCertified: o.hazmat ?? false,
      maxWeightLbs: o.maxWeight ?? "500",
      maxDimensionIn: o.maxDim ?? "100",
      baseCostCents: o.base ?? 1000,
      costPerLbCents: o.perLb ?? 50,
      transitDays: o.transit ?? 3,
      reliability: o.reliability ?? "0.950",
    })
    .returning({ id: carriers.id });
  const row = rows[0];
  if (!row) throw new Error("carrier insert failed");
  return row.id;
}

export async function makeVendorContract(skuId: number, o: { tier: 1 | 2 | 3; unitCostCents?: number; lead?: number; maxQty?: number; maxLead?: number }): Promise<{ vendorId: number }> {
  const db = getDb();
  const v = await db.insert(vendors).values({ name: `Vendor ${uid()}` }).returning({ id: vendors.id });
  const vendorId = v[0]?.id;
  if (vendorId === undefined) throw new Error("vendor insert failed");
  await db.insert(vendorContracts).values({
    vendorId,
    skuId,
    hierarchyTier: o.tier,
    unitCostCents: o.unitCostCents ?? 500,
    leadTimeDays: o.lead ?? 5,
    maxQtyPerOrder: o.maxQty ?? 100_000,
    maxAcceptableLeadDays: o.maxLead ?? 14,
  });
  return { vendorId };
}
