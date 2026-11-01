CREATE TYPE "public"."actor_type" AS ENUM('USER', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."carrier_mode" AS ENUM('AIR_EXPRESS', 'GROUND_FREIGHT', 'PARCEL');--> statement-breakpoint
CREATE TYPE "public"."exception_severity" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."exception_status" AS ENUM('OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."exception_type" AS ENUM('ORDER_ADDRESS_INVALID', 'ORDER_CREDIT_EXCEEDED', 'ORDER_HAZMAT_RESTRICTED', 'ORDER_CUSTOMER_INACTIVE', 'ORDER_PRODUCT_INACTIVE', 'NO_WAREHOUSE_CAN_FULFIL', 'NO_ELIGIBLE_CARRIER', 'PO_APPROVAL_REQUIRED', 'NO_VENDOR_AVAILABLE', 'RMA_REVIEW', 'RETURN_GRADING', 'LEDGER_MISMATCH');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_status" AS ENUM('RESERVED', 'SHIPPED', 'DELIVERED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('RECEIPT', 'RESERVE', 'RELEASE', 'SHIP', 'RETURN_RESTOCK', 'RETURN_QUARANTINE', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('ON_HOLD_EXCEPTION', 'BACKORDERED', 'RESERVED', 'CONFIRMED', 'PARTIALLY_SHIPPED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."po_status" AS ENUM('PENDING_BUYER_APPROVAL', 'PENDING_MANAGER_APPROVAL', 'APPROVED_AND_DISPATCHED', 'RECEIVED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."requisition_status" AS ENUM('OPEN', 'CONVERTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('ACTIVE', 'RELEASED', 'FULFILLED');--> statement-breakpoint
CREATE TYPE "public"."return_condition" AS ENUM('VERIFIED_NEW', 'OPENED_GOOD', 'DAMAGED');--> statement-breakpoint
CREATE TYPE "public"."return_disposition" AS ENUM('PENDING', 'RESTOCK_PRIME', 'QUARANTINE_REFURBISHMENT');--> statement-breakpoint
CREATE TYPE "public"."rma_status" AS ENUM('PENDING_REVIEW', 'APPROVED', 'DENIED', 'RECEIVED', 'INSPECTED', 'REFUNDED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."selection_rule" AS ENUM('URGENT_AIR', 'HEAVY_GROUND', 'WEIGHTED_SCORE');--> statement-breakpoint
CREATE TYPE "public"."shipment_priority" AS ENUM('STANDARD', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('BOOKED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('ADMIN', 'WAREHOUSE_TECH', 'CUSTOMER_SERVICE', 'BUYER', 'MANAGER');--> statement-breakpoint
CREATE TYPE "public"."zone_status" AS ENUM('PRIME', 'QUARANTINE_REFURBISHMENT', 'QUARANTINE_QUALITY');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason_code" text,
	"correlation_id" text NOT NULL,
	CONSTRAINT "audit_actor_ck" CHECK (("audit_logs"."actor_type" = 'SYSTEM') OR ("audit_logs"."actor_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "business_rules_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "exceptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" "exception_type" NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"severity" "exception_severity" NOT NULL,
	"status" "exception_status" DEFAULT 'OPEN' NOT NULL,
	"reason_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_to" uuid,
	"requested_by" uuid,
	"due_at" timestamp with time zone NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	CONSTRAINT "exceptions_resolved_ck" CHECK (("exceptions"."status" IN ('RESOLVED','DISMISSED')) = ("exceptions"."resolved_at" IS NOT NULL AND "exceptions"."resolved_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idem_key_len_ck" CHECK (char_length("idempotency_keys"."key") BETWEEN 8 AND 128)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_batches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"zone_status" "zone_status" DEFAULT 'PRIME' NOT NULL,
	"qty_available" integer NOT NULL,
	"qty_reserved" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expiry_date" date,
	"lot_code" text NOT NULL,
	CONSTRAINT "batches_avail_ck" CHECK ("inventory_batches"."qty_available" >= 0),
	CONSTRAINT "batches_reserved_ck" CHECK ("inventory_batches"."qty_reserved" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"batch_id" bigint NOT NULL,
	"sku_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"entry_type" "ledger_entry_type" NOT NULL,
	"delta_available" integer NOT NULL,
	"delta_reserved" integer NOT NULL,
	"reference_type" text,
	"reference_id" text,
	"reason_code" text NOT NULL,
	"actor_id" uuid,
	"correlation_id" text NOT NULL,
	CONSTRAINT "ledger_nonzero_ck" CHECK ("inventory_ledger"."delta_available" <> 0 OR "inventory_ledger"."delta_reserved" <> 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_requisitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"qty" integer NOT NULL,
	"status" "requisition_status" DEFAULT 'OPEN' NOT NULL,
	"rop_at_creation" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requisitions_qty_ck" CHECK ("purchase_requisitions"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"batch_id" bigint NOT NULL,
	"sku_id" integer NOT NULL,
	"qty" integer NOT NULL,
	"status" "reservation_status" DEFAULT 'ACTIVE' NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_qty_ck" CHECK ("reservations"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"is_perishable" boolean DEFAULT false NOT NULL,
	"shelf_life_days" integer,
	"is_hazmat" boolean DEFAULT false NOT NULL,
	"weight_lbs" numeric(10, 2) NOT NULL,
	"max_dimension_in" numeric(8, 2) NOT NULL,
	"list_price_cents" bigint NOT NULL,
	"lead_time_days_avg" numeric(6, 2) NOT NULL,
	CONSTRAINT "skus_perishable_ck" CHECK (NOT "skus"."is_perishable" OR "skus"."shelf_life_days" > 0),
	CONSTRAINT "skus_price_ck" CHECK ("skus"."list_price_cents" >= 0),
	CONSTRAINT "skus_lead_ck" CHECK ("skus"."lead_time_days_avg" >= 0)
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "warehouses_lat_ck" CHECK ("warehouses"."lat" BETWEEN -90 AND 90),
	CONSTRAINT "warehouses_lng_ck" CHECK ("warehouses"."lng" BETWEEN -180 AND 180)
);
--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"line1" text NOT NULL,
	"city" text NOT NULL,
	"region" text NOT NULL,
	"postal_code" text NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"lat" double precision,
	"lng" double precision,
	CONSTRAINT "addresses_lat_ck" CHECK ("addresses"."lat" IS NULL OR "addresses"."lat" BETWEEN -90 AND 90),
	CONSTRAINT "addresses_lng_ck" CHECK ("addresses"."lng" IS NULL OR "addresses"."lng" BETWEEN -180 AND 180),
	CONSTRAINT "addresses_pair_ck" CHECK (("addresses"."lat" IS NULL) = ("addresses"."lng" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "contract_prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"price_cents" bigint NOT NULL,
	CONSTRAINT "contract_price_ck" CHECK ("contract_prices"."price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "customer_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"credit_limit_cents" bigint NOT NULL,
	"current_balance_cents" bigint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "accounts_limit_ck" CHECK ("customer_accounts"."credit_limit_cents" >= 0),
	CONSTRAINT "accounts_balance_ck" CHECK ("customer_accounts"."current_balance_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fulfillment_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"fulfillment_order_id" integer NOT NULL,
	"order_line_id" integer NOT NULL,
	"qty" integer NOT NULL,
	CONSTRAINT "fulfillment_lines_qty_ck" CHECK ("fulfillment_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "fulfillment_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"status" "fulfillment_status" DEFAULT 'RESERVED' NOT NULL,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hazmat_restricted_regions" (
	"id" serial PRIMARY KEY NOT NULL,
	"country" text NOT NULL,
	"region" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"line_total_cents" bigint NOT NULL,
	"is_customized" boolean DEFAULT false NOT NULL,
	"qty_returned" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "order_lines_qty_ck" CHECK ("order_lines"."qty" > 0),
	CONSTRAINT "order_lines_total_ck" CHECK ("order_lines"."line_total_cents" = "order_lines"."unit_price_cents" * "order_lines"."qty"),
	CONSTRAINT "order_lines_returned_ck" CHECK ("order_lines"."qty_returned" BETWEEN 0 AND "order_lines"."qty")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_number" text NOT NULL,
	"customer_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"address_id" integer NOT NULL,
	"status" "order_status" NOT NULL,
	"hold_reason_code" text,
	"total_cents" bigint NOT NULL,
	"reservation_expires_at" timestamp with time zone,
	"priority" text DEFAULT 'STANDARD' NOT NULL,
	"delivery_window_days" integer DEFAULT 7 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_total_ck" CHECK ("orders"."total_cents" >= 0),
	CONSTRAINT "orders_priority_ck" CHECK ("orders"."priority" IN ('STANDARD','URGENT')),
	CONSTRAINT "orders_window_ck" CHECK ("orders"."delivery_window_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "carriers" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"mode" "carrier_mode" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"hazmat_certified" boolean DEFAULT false NOT NULL,
	"max_weight_lbs" numeric(10, 2) NOT NULL,
	"max_dimension_in" numeric(8, 2) NOT NULL,
	"base_cost_cents" bigint NOT NULL,
	"cost_per_lb_cents" bigint NOT NULL,
	"transit_days" integer NOT NULL,
	"reliability" numeric(4, 3) NOT NULL,
	CONSTRAINT "carriers_reliability_ck" CHECK ("carriers"."reliability" BETWEEN 0 AND 1),
	CONSTRAINT "carriers_transit_ck" CHECK ("carriers"."transit_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_order_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"qty" integer NOT NULL,
	"unit_cost_cents" bigint NOT NULL,
	"line_total_cents" bigint NOT NULL,
	"qty_received" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "po_lines_qty_ck" CHECK ("purchase_order_lines"."qty" > 0),
	CONSTRAINT "po_lines_received_ck" CHECK ("purchase_order_lines"."qty_received" BETWEEN 0 AND "purchase_order_lines"."qty"),
	CONSTRAINT "po_lines_total_ck" CHECK ("purchase_order_lines"."line_total_cents" = "purchase_order_lines"."unit_cost_cents" * "purchase_order_lines"."qty")
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"po_number" text NOT NULL,
	"vendor_id" integer NOT NULL,
	"requisition_id" integer,
	"status" "po_status" NOT NULL,
	"hierarchy_tier" smallint NOT NULL,
	"total_cost_cents" bigint NOT NULL,
	"requested_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_reason_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "po_total_ck" CHECK ("purchase_orders"."total_cost_cents" >= 0),
	CONSTRAINT "po_sod_ck" CHECK ("purchase_orders"."approved_by" IS NULL OR "purchase_orders"."requested_by" IS NULL OR "purchase_orders"."approved_by" <> "purchase_orders"."requested_by"),
	CONSTRAINT "po_approval_pair_ck" CHECK (("purchase_orders"."approved_by" IS NULL) = ("purchase_orders"."approved_at" IS NULL)),
	CONSTRAINT "po_manual_approval_ck" CHECK ("purchase_orders"."status" NOT IN ('APPROVED_AND_DISPATCHED') OR "purchase_orders"."approved_by" IS NOT NULL OR ("purchase_orders"."hierarchy_tier" < 3 AND "purchase_orders"."approval_reason_code" = 'AUTO_BELOW_THRESHOLD'))
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" serial PRIMARY KEY NOT NULL,
	"fulfillment_order_id" integer NOT NULL,
	"carrier_id" integer NOT NULL,
	"status" "shipment_status" DEFAULT 'BOOKED' NOT NULL,
	"priority" "shipment_priority" NOT NULL,
	"selection_rule" "selection_rule" NOT NULL,
	"weight_lbs" numeric(10, 2) NOT NULL,
	"delivery_window_days" integer NOT NULL,
	"cost_cents" bigint NOT NULL,
	"tracking_number" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_cost_ck" CHECK ("shipments"."cost_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "vendor_contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"hierarchy_tier" smallint NOT NULL,
	"unit_cost_cents" bigint NOT NULL,
	"lead_time_days" integer NOT NULL,
	"max_qty_per_order" integer NOT NULL,
	"max_acceptable_lead_days" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "vendor_contracts_tier_ck" CHECK ("vendor_contracts"."hierarchy_tier" IN (1,2,3)),
	CONSTRAINT "vendor_contracts_qty_ck" CHECK ("vendor_contracts"."max_qty_per_order" > 0)
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" serial PRIMARY KEY NOT NULL,
	"rma_id" integer NOT NULL,
	"amount_cents" bigint NOT NULL,
	"issued_by" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_amount_ck" CHECK ("refunds"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "rma_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"rma_id" integer NOT NULL,
	"order_line_id" integer NOT NULL,
	"qty" integer NOT NULL,
	"is_opened" boolean,
	"condition" "return_condition",
	"disposition" "return_disposition" DEFAULT 'PENDING' NOT NULL,
	"refund_cents" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "rma_lines_qty_ck" CHECK ("rma_lines"."qty" > 0),
	CONSTRAINT "rma_lines_refund_ck" CHECK ("rma_lines"."refund_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rmas" (
	"id" serial PRIMARY KEY NOT NULL,
	"rma_number" text NOT NULL,
	"order_id" integer NOT NULL,
	"status" "rma_status" NOT NULL,
	"reason_code" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_rules_config" ADD CONSTRAINT "business_rules_config_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_batch_id_inventory_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."inventory_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_batch_id_inventory_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."inventory_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_prices" ADD CONSTRAINT "contract_prices_account_id_customer_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_prices" ADD CONSTRAINT "contract_prices_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_account_id_customer_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_lines" ADD CONSTRAINT "fulfillment_lines_fulfillment_order_id_fulfillment_orders_id_fk" FOREIGN KEY ("fulfillment_order_id") REFERENCES "public"."fulfillment_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_lines" ADD CONSTRAINT "fulfillment_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_orders" ADD CONSTRAINT "fulfillment_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_orders" ADD CONSTRAINT "fulfillment_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_customer_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_address_id_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_requisition_id_purchase_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."purchase_requisitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_fulfillment_order_id_fulfillment_orders_id_fk" FOREIGN KEY ("fulfillment_order_id") REFERENCES "public"."fulfillment_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contracts" ADD CONSTRAINT "vendor_contracts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contracts" ADD CONSTRAINT "vendor_contracts_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_rma_id_rmas_id_fk" FOREIGN KEY ("rma_id") REFERENCES "public"."rmas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rma_lines" ADD CONSTRAINT "rma_lines_rma_id_rmas_id_fk" FOREIGN KEY ("rma_id") REFERENCES "public"."rmas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rma_lines" ADD CONSTRAINT "rma_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rmas" ADD CONSTRAINT "rmas_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rmas" ADD CONSTRAINT "rmas_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_occurred_idx" ON "audit_logs" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "brc_key_from_uq" ON "business_rules_config" USING btree ("key","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "exceptions_live_uq" ON "exceptions" USING btree ("entity_type","entity_id","type") WHERE "exceptions"."status" IN ('OPEN','IN_REVIEW');--> statement-breakpoint
CREATE INDEX "exceptions_queue_idx" ON "exceptions" USING btree ("due_at","id") WHERE "exceptions"."status" IN ('OPEN','IN_REVIEW');--> statement-breakpoint
CREATE UNIQUE INDEX "idem_scope_key_uq" ON "idempotency_keys" USING btree ("scope","key");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "batches_fefo_idx" ON "inventory_batches" USING btree ("sku_id","warehouse_id","zone_status","expiry_date","received_at","id") WHERE "inventory_batches"."qty_available" > 0;--> statement-breakpoint
CREATE INDEX "batches_fifo_idx" ON "inventory_batches" USING btree ("sku_id","warehouse_id","zone_status","received_at","id") WHERE "inventory_batches"."qty_available" > 0;--> statement-breakpoint
CREATE INDEX "batches_sku_wh_idx" ON "inventory_batches" USING btree ("sku_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "ledger_batch_idx" ON "inventory_ledger" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "ledger_demand_idx" ON "inventory_ledger" USING btree ("sku_id","occurred_at") WHERE "inventory_ledger"."entry_type" = 'SHIP';--> statement-breakpoint
CREATE INDEX "ledger_ref_idx" ON "inventory_ledger" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requisitions_open_sku_uq" ON "purchase_requisitions" USING btree ("sku_id") WHERE "purchase_requisitions"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "reservations_owner_idx" ON "reservations" USING btree ("owner_type","owner_id") WHERE "reservations"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "reservations_expiry_idx" ON "reservations" USING btree ("expires_at") WHERE "reservations"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "skus_code_uq" ON "skus" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_code_uq" ON "warehouses" USING btree ("code");--> statement-breakpoint
CREATE INDEX "addresses_customer_idx" ON "addresses" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_prices_uq" ON "contract_prices" USING btree ("account_id","sku_id");--> statement-breakpoint
CREATE INDEX "customers_account_idx" ON "customers" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_email_uq" ON "customers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "fulfillment_lines_fo_idx" ON "fulfillment_lines" USING btree ("fulfillment_order_id");--> statement-breakpoint
CREATE INDEX "fulfillment_lines_ol_idx" ON "fulfillment_lines" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "fulfillment_order_idx" ON "fulfillment_orders" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hazmat_region_uq" ON "hazmat_restricted_regions" USING btree ("country","region");--> statement-breakpoint
CREATE INDEX "order_lines_order_idx" ON "order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_lines_order_sku_uq" ON "order_lines" USING btree ("order_id","sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_number_uq" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "orders_list_idx" ON "orders" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "orders_expiry_idx" ON "orders" USING btree ("reservation_expires_at") WHERE "orders"."status" = 'RESERVED';--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carriers_code_uq" ON "carriers" USING btree ("code");--> statement-breakpoint
CREATE INDEX "carriers_active_idx" ON "carriers" USING btree ("mode") WHERE "carriers"."active";--> statement-breakpoint
CREATE INDEX "po_lines_po_idx" ON "purchase_order_lines" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "po_lines_sku_idx" ON "purchase_order_lines" USING btree ("sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "po_number_uq" ON "purchase_orders" USING btree ("po_number");--> statement-breakpoint
CREATE INDEX "po_list_idx" ON "purchase_orders" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "po_vendor_day_idx" ON "purchase_orders" USING btree ("vendor_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "po_requisition_uq" ON "purchase_orders" USING btree ("requisition_id") WHERE "purchase_orders"."requisition_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_fulfillment_uq" ON "shipments" USING btree ("fulfillment_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_tracking_uq" ON "shipments" USING btree ("tracking_number");--> statement-breakpoint
CREATE INDEX "shipments_list_idx" ON "shipments" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_contracts_uq" ON "vendor_contracts" USING btree ("sku_id","vendor_id");--> statement-breakpoint
CREATE INDEX "vendor_contracts_tier_idx" ON "vendor_contracts" USING btree ("sku_id","hierarchy_tier") WHERE "vendor_contracts"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_rma_uq" ON "refunds" USING btree ("rma_id");--> statement-breakpoint
CREATE INDEX "rma_lines_rma_idx" ON "rma_lines" USING btree ("rma_id");--> statement-breakpoint
CREATE INDEX "rma_lines_order_line_idx" ON "rma_lines" USING btree ("order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rmas_number_uq" ON "rmas" USING btree ("rma_number");--> statement-breakpoint
CREATE INDEX "rmas_list_idx" ON "rmas" USING btree ("requested_at","id");--> statement-breakpoint
CREATE INDEX "rmas_order_idx" ON "rmas" USING btree ("order_id");