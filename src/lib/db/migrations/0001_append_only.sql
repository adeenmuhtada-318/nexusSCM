-- Custom migration: audit_logs and inventory_ledger are APPEND-ONLY (CLAUDE.md §4.8).
-- Enforced with triggers (role-agnostic; works on Neon/Supabase without managing DB roles).
-- Corrections must be written as new compensating rows.
CREATE OR REPLACE FUNCTION nexus_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% blocked)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION nexus_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER inventory_ledger_append_only BEFORE UPDATE OR DELETE ON inventory_ledger
  FOR EACH ROW EXECUTE FUNCTION nexus_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION nexus_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER inventory_ledger_no_truncate BEFORE TRUNCATE ON inventory_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION nexus_forbid_mutation();
