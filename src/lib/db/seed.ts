import "server-only";
import bcrypt from "bcryptjs";
import { count, eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "./index";
import { runTransaction } from "./tx";
import {
  addresses,
  carriers,
  contractPrices,
  customerAccounts,
  customers,
  fulfillmentOrders,
  hazmatRestrictedRegions,
  inventoryBatches,
  orderLines,
  purchaseRequisitions,
  skus,
  users,
  vendorContracts,
  vendors,
  warehouses,
} from "./schema";
import { seedBusinessRuleDefaults } from "@/lib/config/business-rules";
import { createRequisition, receiveStock } from "@/modules/inventory";
import { confirmOrder, createOrder, markFulfillmentDelivered, shipFulfillment } from "@/modules/orders";
import { createPoFromRequisition } from "@/modules/procurement";
import { receiveAndInspectRma, requestRma } from "@/modules/returns";

export const DEMO_PASSWORD = "Nexus123!";

function must<T>(val: T | undefined, label: string): T {
  if (val === undefined) throw new Error(`Seed invariant failed: ${label}`);
  return val;
}

/**
 * Seeds realistic reference data, demo RBAC users, live HITL workflows across all 5 modules, and set-based bulk
 * inventory_batches + inventory_ledger rows (default 100,000 batches) that satisfy 100% ledger reconciliation.
 */
export async function seedDatabase(opts: { bulkBatches?: number } = {}): Promise<{ skipped: boolean; batchesTotal: number }> {
  const bulkBatches = opts.bulkBatches ?? 100_000;
  const db = getDb();
  await seedBusinessRuleDefaults(db);

  const existingAdmin = await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@nexus.local")).limit(1);
  if (existingAdmin.length > 0) {
    const totals = await db.select({ total: count() }).from(inventoryBatches);
    return { skipped: true, batchesTotal: totals[0]?.total ?? 0 };
  }

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const insertedUsers = await db
    .insert(users)
    .values([
      { email: "admin@nexus.local", name: "Avery Lin (Admin)", passwordHash: hash, role: "ADMIN" },
      { email: "tech@nexus.local", name: "Devon Brooks (Dock Tech)", passwordHash: hash, role: "WAREHOUSE_TECH" },
      { email: "cs@nexus.local", name: "Maya Patel (Customer Service)", passwordHash: hash, role: "CUSTOMER_SERVICE" },
      { email: "buyer@nexus.local", name: "Jordan Reeves (Buyer)", passwordHash: hash, role: "BUYER" },
      { email: "manager@nexus.local", name: "Elena Rostova (Ops Manager)", passwordHash: hash, role: "MANAGER" },
    ])
    .returning({ id: users.id, role: users.role });

  const uidByRole = (role: string) => must(insertedUsers.find((r) => r.role === role), `role ${role}`).id;
  const techActor = { type: "USER" as const, id: uidByRole("WAREHOUSE_TECH") };
  const csActor = { type: "USER" as const, id: uidByRole("CUSTOMER_SERVICE") };
  const buyerActor = { type: "USER" as const, id: uidByRole("BUYER") };

  const whs = await db
    .insert(warehouses)
    .values([
      { code: "EWR-01", name: "Newark East Distribution", lat: 40.6895, lng: -74.1745, timezone: "America/New_York" },
      { code: "ORD-02", name: "Chicago Midwest Hub", lat: 41.9742, lng: -87.9073, timezone: "America/New_York" },
      { code: "LAX-03", name: "Los Angeles West Hub", lat: 33.9416, lng: -118.4085, timezone: "America/New_York" },
      { code: "DFW-04", name: "Dallas South Hub", lat: 32.8998, lng: -97.0403, timezone: "America/New_York" },
    ])
    .returning({ id: warehouses.id, code: warehouses.code });
  const whEwr = must(whs[0], "wh0").id;
  const whLax = must(whs[2], "wh2").id;

  await db.insert(hazmatRestrictedRegions).values([
    { country: "US", region: "HI" },
    { country: "US", region: "AK" },
  ]);

  const skuRows = await db
    .insert(skus)
    .values([
      { code: "SKU-STD-101", name: "Industrial Servo Motor 2kW", category: "motion", weightLbs: "14.50", maxDimensionIn: "18.00", listPriceCents: 42_500, leadTimeDaysAvg: "6" },
      { code: "SKU-STD-102", name: "Precision Torque Sensor", category: "sensors", weightLbs: "2.20", maxDimensionIn: "8.00", listPriceCents: 18_900, leadTimeDaysAvg: "9" },
      { code: "SKU-PER-201", name: "Cold-Chain Biologic Vial 50mL", category: "biologics", isPerishable: true, shelfLifeDays: 90, weightLbs: "0.80", maxDimensionIn: "6.00", listPriceCents: 31_000, leadTimeDaysAvg: "4" },
      { code: "SKU-PER-202", name: "Sterile Assay Reagent Kit", category: "biologics", isPerishable: true, shelfLifeDays: 60, weightLbs: "1.50", maxDimensionIn: "10.00", listPriceCents: 14_500, leadTimeDaysAvg: "5" },
      { code: "SKU-HAZ-301", name: "Lithium-Ion Rack Module 48V", category: "power", isHazmat: true, weightLbs: "48.00", maxDimensionIn: "24.00", listPriceCents: 95_000, leadTimeDaysAvg: "12" },
      { code: "SKU-CUS-401", name: "Custom-Machined Valve Manifold", category: "fluidics", weightLbs: "9.00", maxDimensionIn: "14.00", listPriceCents: 56_000, leadTimeDaysAvg: "10" },
      { code: "SKU-HVY-501", name: "Hydraulic Press Cylinder 20T", category: "hydraulics", weightLbs: "185.00", maxDimensionIn: "52.00", listPriceCents: 145_000, leadTimeDaysAvg: "14" },
      { code: "SKU-SPT-601", name: "Rare-Earth Magnet Array", category: "components", weightLbs: "4.00", maxDimensionIn: "9.00", listPriceCents: 28_000, leadTimeDaysAvg: "7" },
      { code: "SKU-NOV-602", name: "Legacy PLC Backplane", category: "controls", weightLbs: "3.10", maxDimensionIn: "12.00", listPriceCents: 22_000, leadTimeDaysAvg: "8" },
      { code: "SKU-BLK-701", name: "M8 Stainless Fastener Carton", category: "hardware", weightLbs: "6.00", maxDimensionIn: "10.00", listPriceCents: 3_800, leadTimeDaysAvg: "5" },
    ])
    .returning({ id: skus.id, code: skus.code });
  const skuBy = (code: string) => must(skuRows.find((s) => s.code === code), `sku ${code}`).id;

  await db.insert(carriers).values([
    { code: "UPS-PAR", name: "UPS Commercial Parcel", mode: "PARCEL", hazmatCertified: false, maxWeightLbs: "70", maxDimensionIn: "48", baseCostCents: 1_250, costPerLbCents: 65, transitDays: 4, reliability: "0.962" },
    { code: "FDX-GND", name: "FedEx Freight Ground", mode: "GROUND_FREIGHT", hazmatCertified: true, maxWeightLbs: "2000", maxDimensionIn: "96", baseCostCents: 4_800, costPerLbCents: 42, transitDays: 5, reliability: "0.975" },
    { code: "DHL-AIR", name: "DHL Express Air Cargo", mode: "AIR_EXPRESS", hazmatCertified: true, maxWeightLbs: "600", maxDimensionIn: "72", baseCostCents: 9_500, costPerLbCents: 145, transitDays: 2, reliability: "0.988" },
    { code: "XPO-HVY", name: "XPO Heavy LTL", mode: "GROUND_FREIGHT", hazmatCertified: false, maxWeightLbs: "5000", maxDimensionIn: "120", baseCostCents: 6_200, costPerLbCents: 30, transitDays: 6, reliability: "0.945" },
  ]);

  const vRows = await db
    .insert(vendors)
    .values([{ name: "Bosch Rexroth Supply" }, { name: "Pacific Precision Metals" }, { name: "SpotSource Industrial Brokers" }])
    .returning({ id: vendors.id });
  const v1 = must(vRows[0], "v1").id;
  const v2 = must(vRows[1], "v2").id;
  const v3 = must(vRows[2], "v3").id;

  await db.insert(vendorContracts).values([
    { vendorId: v1, skuId: skuBy("SKU-STD-101"), hierarchyTier: 1, unitCostCents: 28_000, leadTimeDays: 6, maxQtyPerOrder: 500, maxAcceptableLeadDays: 10 },
    { vendorId: v2, skuId: skuBy("SKU-STD-101"), hierarchyTier: 2, unitCostCents: 31_000, leadTimeDays: 5, maxQtyPerOrder: 1500, maxAcceptableLeadDays: 10 },
    { vendorId: v1, skuId: skuBy("SKU-STD-102"), hierarchyTier: 1, unitCostCents: 11_500, leadTimeDays: 7, maxQtyPerOrder: 1000, maxAcceptableLeadDays: 12 },
    { vendorId: v1, skuId: skuBy("SKU-PER-201"), hierarchyTier: 1, unitCostCents: 19_000, leadTimeDays: 4, maxQtyPerOrder: 800, maxAcceptableLeadDays: 7 },
    { vendorId: v2, skuId: skuBy("SKU-HAZ-301"), hierarchyTier: 1, unitCostCents: 64_000, leadTimeDays: 10, maxQtyPerOrder: 300, maxAcceptableLeadDays: 14 },
    { vendorId: v3, skuId: skuBy("SKU-SPT-601"), hierarchyTier: 3, unitCostCents: 17_500, leadTimeDays: 6, maxQtyPerOrder: 400, maxAcceptableLeadDays: 10 },
    { vendorId: v1, skuId: skuBy("SKU-BLK-701"), hierarchyTier: 1, unitCostCents: 2_100, leadTimeDays: 5, maxQtyPerOrder: 10_000, maxAcceptableLeadDays: 10 },
  ]);

  const accts = await db
    .insert(customerAccounts)
    .values([
      { name: "Apex Robotics Corp", creditLimitCents: 15_000_000, currentBalanceCents: 0 },
      { name: "Beacon Diagnostics LLC", creditLimitCents: 80_000, currentBalanceCents: 0 },
    ])
    .returning({ id: customerAccounts.id });
  const acctApex = must(accts[0], "acct0").id;
  const acctBeacon = must(accts[1], "acct1").id;

  const custs = await db
    .insert(customers)
    .values([
      { accountId: acctApex, name: "Apex East Purchasing", email: "orders@apexrobotics.example" },
      { accountId: acctBeacon, name: "Beacon Lab Ops", email: "receiving@beacondiag.example" },
    ])
    .returning({ id: customers.id });
  const custApex = must(custs[0], "cust0").id;
  const custBeacon = must(custs[1], "cust1").id;

  const addrRows = await db
    .insert(addresses)
    .values([
      { customerId: custApex, line1: "350 5th Ave", city: "New York", region: "NY", postalCode: "10118", lat: 40.7484, lng: -73.9857 },
      { customerId: custApex, line1: "1000 Bishop St", city: "Honolulu", region: "HI", postalCode: "96813", lat: 21.3069, lng: -157.8583 },
      { customerId: custApex, line1: "PO Box 99 Unmapped", city: "Reno", region: "NV", postalCode: "89501", lat: null, lng: null },
      { customerId: custBeacon, line1: "200 Clarendon St", city: "Boston", region: "MA", postalCode: "02116", lat: 42.3493, lng: -71.0753 },
    ])
    .returning({ id: addresses.id });
  const addrNy = must(addrRows[0], "addr0").id;
  const addrHi = must(addrRows[1], "addr1").id;
  const addrBos = must(addrRows[3], "addr3").id;

  await db.insert(contractPrices).values([
    { accountId: acctApex, skuId: skuBy("SKU-STD-101"), priceCents: 39_000 },
    { accountId: acctApex, skuId: skuBy("SKU-BLK-701"), priceCents: 3_400 },
  ]);

  const now = new Date();
  const in60Days = new Date(now.getTime() + 60 * 86_400_000).toISOString().slice(0, 10);
  const in5Days = new Date(now.getTime() + 5 * 86_400_000).toISOString().slice(0, 10);

  await runTransaction(async (tx) => {
    await receiveStock(tx, { skuId: skuBy("SKU-STD-101"), warehouseId: whEwr, qty: 120, zone: "PRIME", entryType: "RECEIPT", expiryDate: null, lotCode: "LOT-STD-A", reasonCode: "SEED_INIT", actor: techActor, correlationId: "seed" });
    await receiveStock(tx, { skuId: skuBy("SKU-PER-201"), warehouseId: whEwr, qty: 15, zone: "PRIME", entryType: "RECEIPT", expiryDate: in5Days, lotCode: "LOT-PER-SHORT", reasonCode: "SEED_INIT", actor: techActor, correlationId: "seed" });
    await receiveStock(tx, { skuId: skuBy("SKU-PER-201"), warehouseId: whEwr, qty: 80, zone: "PRIME", entryType: "RECEIPT", expiryDate: in60Days, lotCode: "LOT-PER-FRESH", reasonCode: "SEED_INIT", actor: techActor, correlationId: "seed" });
    await receiveStock(tx, { skuId: skuBy("SKU-HAZ-301"), warehouseId: whLax, qty: 40, zone: "PRIME", entryType: "RECEIPT", expiryDate: null, lotCode: "LOT-HAZ-1", reasonCode: "SEED_INIT", actor: techActor, correlationId: "seed" });
    await receiveStock(tx, { skuId: skuBy("SKU-CUS-401"), warehouseId: whEwr, qty: 30, zone: "PRIME", entryType: "RECEIPT", expiryDate: null, lotCode: "LOT-CUS-1", reasonCode: "SEED_INIT", actor: techActor, correlationId: "seed" });
    await receiveStock(tx, { skuId: skuBy("SKU-STD-102"), warehouseId: whEwr, qty: 4, zone: "QUARANTINE_QUALITY", entryType: "RECEIPT", expiryDate: null, lotCode: "LOT-DMG-1", reasonCode: "SEED_DAMAGED", actor: techActor, correlationId: "seed" });
  });

  if (bulkBatches > 0) {
    await seedBulkBatchesAndLedger(bulkBatches, whs.map((w) => w.id), skuBy("SKU-BLK-701"), skuBy("SKU-PER-202"));
  }

  await runTransaction(async (tx) => {
    const delivered = await createOrder(tx, {
      customerId: custApex,
      addressId: addrNy,
      lines: [
        { skuId: skuBy("SKU-STD-101"), qty: 4, isCustomized: false },
        { skuId: skuBy("SKU-PER-201"), qty: 3, isCustomized: false },
      ],
      priority: "STANDARD",
      deliveryWindowDays: 7,
      idempotencyKey: "seed-order-delivered-01",
      actor: csActor,
      correlationId: "seed-ord-1",
      now,
    });
    await confirmOrder(tx, { orderId: delivered.result.orderId, actor: csActor, correlationId: "seed-ord-1", now });
    const fos = await tx.select({ id: fulfillmentOrders.id }).from(fulfillmentOrders).where(eq(fulfillmentOrders.orderId, delivered.result.orderId));
    for (const fo of fos) {
      await shipFulfillment(tx, { fulfillmentId: fo.id, actor: techActor, correlationId: "seed-ord-1", now, requestedBy: techActor.id });
      await markFulfillmentDelivered(tx, { fulfillmentId: fo.id, actor: techActor, correlationId: "seed-ord-1", now });
    }
    const oLines = await tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, delivered.result.orderId));
    const rma = await requestRma(tx, {
      orderId: delivered.result.orderId,
      lines: [{ orderLineId: must(oLines[0], "oLine0").id, qty: 2 }],
      reasonCode: "DAMAGED_IN_TRANSIT",
      idempotencyKey: "seed-rma-grading-01",
      actor: csActor,
      correlationId: "seed-rma-1",
      now,
    });
    const detail = await tx.execute<{ id: string | number }>(sql`SELECT id FROM rma_lines WHERE rma_id = ${rma.result.rmaId}::int`);
    await receiveAndInspectRma(tx, {
      rmaId: rma.result.rmaId,
      warehouseId: whEwr,
      lines: [{ rmaLineId: Number(must(detail[0], "rmaLine0").id), isOpened: true, condition: "OPENED_GOOD" }],
      actor: techActor,
      correlationId: "seed-rma-1",
      now,
    });

    await createOrder(tx, {
      customerId: custBeacon,
      addressId: addrBos,
      lines: [{ skuId: skuBy("SKU-STD-101"), qty: 5, isCustomized: false }],
      priority: "STANDARD",
      deliveryWindowDays: 7,
      idempotencyKey: "seed-order-credithold-02",
      actor: csActor,
      correlationId: "seed-ord-2",
      now,
    });
    await createOrder(tx, {
      customerId: custApex,
      addressId: addrHi,
      lines: [{ skuId: skuBy("SKU-HAZ-301"), qty: 1, isCustomized: false }],
      priority: "URGENT",
      deliveryWindowDays: 3,
      idempotencyKey: "seed-order-hazmathold-03",
      actor: csActor,
      correlationId: "seed-ord-3",
      now,
    });
    await createOrder(tx, {
      customerId: custApex,
      addressId: addrNy,
      lines: [{ skuId: skuBy("SKU-CUS-401"), qty: 2, isCustomized: true }],
      priority: "STANDARD",
      deliveryWindowDays: 5,
      idempotencyKey: "seed-order-reserved-04",
      actor: csActor,
      correlationId: "seed-ord-4",
      now,
    });

    const reqHigh = await createRequisition(tx, { skuId: skuBy("SKU-HAZ-301"), qty: 20, rop: 15, actor: buyerActor, correlationId: "seed-po-1" });
    if (reqHigh) await createPoFromRequisition(tx, { requisitionId: reqHigh, idempotencyKey: "seed-po-high-01", actor: buyerActor, correlationId: "seed-po-1", now });
    const reqSpot = await createRequisition(tx, { skuId: skuBy("SKU-SPT-601"), qty: 10, rop: 8, actor: buyerActor, correlationId: "seed-po-2" });
    if (reqSpot) await createPoFromRequisition(tx, { requisitionId: reqSpot, idempotencyKey: "seed-po-spot-02", actor: buyerActor, correlationId: "seed-po-2", now });
    await tx.insert(purchaseRequisitions).values({ skuId: skuBy("SKU-STD-102"), qty: 40, ropAtCreation: "22.50" });
  });

  const totals = await db.select({ total: count() }).from(inventoryBatches);
  return { skipped: false, batchesTotal: totals[0]?.total ?? 0 };
}

/**
 * Set-based CTE inserting `n` batches (50% FIFO standard, 50% FEFO perishable) + exact matching RECEIPT/RESERVE/SHIP
 * ledger rows across the trailing 30 days so `reconcileLedger` returns 0 mismatches and EXPLAIN runs at real scale.
 */
async function seedBulkBatchesAndLedger(n: number, whIds: number[], stdSkuId: number, perSkuId: number): Promise<void> {
  const db = getDb();
  const w0 = must(whIds[0], "w0");
  const w1 = whIds[1] ?? w0;
  const w2 = whIds[2] ?? w0;
  const w3 = whIds[3] ?? w0;
  await db.execute(sql`
    WITH gen AS (
      SELECT g,
             CASE WHEN g % 2 = 0 THEN ${stdSkuId}::int ELSE ${perSkuId}::int END AS sku_id,
             (ARRAY[${w0}::int, ${w1}::int, ${w2}::int, ${w3}::int])[1 + (g % 4)] AS wh_id,
             (10 + (g % 25))::int AS avail_qty,
             now() - ((g % 30) || ' days')::interval - ((g % 86400) || ' seconds')::interval AS recv_at,
             CASE WHEN g % 2 = 1 THEN (CURRENT_DATE + (15 + (g % 70)))::date ELSE NULL END AS exp_date
      FROM generate_series(1, ${n}::int) AS g
    ),
    ins AS (
      INSERT INTO inventory_batches (sku_id, warehouse_id, zone_status, qty_available, qty_reserved, received_at, expiry_date, lot_code)
      SELECT sku_id, wh_id, 'PRIME'::zone_status, avail_qty, 0, recv_at, exp_date, 'BULK-' || g
      FROM gen
      RETURNING id, sku_id, warehouse_id, qty_available, received_at
    ),
    paired AS (
      SELECT ins.id AS batch_id, ins.sku_id, ins.warehouse_id, ins.qty_available, ins.received_at,
             CASE WHEN row_number() OVER (ORDER BY ins.id) % 5 = 0 THEN (1 + (row_number() OVER (ORDER BY ins.id) % 6))::int ELSE 0 END AS shipped_qty
      FROM ins
    )
    INSERT INTO inventory_ledger (occurred_at, batch_id, sku_id, warehouse_id, entry_type, delta_available, delta_reserved, reason_code, correlation_id)
    SELECT received_at, batch_id, sku_id, warehouse_id, 'RECEIPT'::ledger_entry_type, qty_available + shipped_qty, 0, 'BULK_SEED', 'bulk-seed'
    FROM paired
    UNION ALL
    SELECT received_at + interval '1 hour', batch_id, sku_id, warehouse_id, 'RESERVE'::ledger_entry_type, -shipped_qty, shipped_qty, 'BULK_SEED', 'bulk-seed'
    FROM paired WHERE shipped_qty > 0
    UNION ALL
    SELECT received_at + interval '2 hours', batch_id, sku_id, warehouse_id, 'SHIP'::ledger_entry_type, 0, -shipped_qty, 'BULK_SEED', 'bulk-seed'
    FROM paired WHERE shipped_qty > 0
  `);
  await db.execute(sql`ANALYZE inventory_batches, inventory_ledger`);
}

const isMain = process.argv[1]?.endsWith("seed.ts");
if (isMain) {
  seedDatabase()
    .then(async (res) => {
      process.stdout.write(`seed finished: skipped=${String(res.skipped)} batches=${res.batchesTotal}\n`);
      await closeDb();
    })
    .catch(async (err: unknown) => {
      process.stderr.write(`seed failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      await closeDb();
      process.exit(1);
    });
}
