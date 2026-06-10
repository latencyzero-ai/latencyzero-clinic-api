-- ============================================================
-- Migration: 002_payment_layer
-- Purpose  : Per-tenant payment config + order payment columns
-- Run via  : pgAdmin against Render Postgres external string
-- Safe to  : re-run (all statements use IF NOT EXISTS / IF EXISTS)
-- ============================================================

-- ─── PHARMACY CONFIG — payment fields ────────────────────────
-- paystack_secret_key is per-tenant and must NEVER be committed
-- to source control. Set it through pgAdmin or the admin API.
ALTER TABLE pharmacy_config
  ADD COLUMN IF NOT EXISTS paystack_secret_key  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS manual_payment_details TEXT;

-- ─── ORDERS — payment & delivery columns ─────────────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_link  TEXT,
  ADD COLUMN IF NOT EXISTS delivery_area TEXT;

-- Index: look up orders by payment_ref (used in payment webhook)
CREATE INDEX IF NOT EXISTS idx_orders_payment_ref
  ON orders (payment_ref)
  WHERE payment_ref IS NOT NULL;
