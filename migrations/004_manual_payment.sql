-- ============================================================
-- Migration: 004_manual_payment
-- Purpose  : Manual bank-transfer payment (v1 — no gateway).
--            Migration 003 rebuilt pharmacy_config WITHOUT the
--            002 payment columns, so the adapter-era schema had
--            no payment config at all. This adds:
--              payment_provider — 'manual' (bank transfer) for v1
--              payment_details  — provider-specific JSONB; for
--                                 'manual': bank_name, account_name,
--                                 account_number
--            and seeds Ochesta's row with PLACEHOLDER values.
--
-- Run via  : pgAdmin against Render Postgres external string
-- Prereqs  : Migration 003 must have been applied.
-- Safe to  : re-run (IF NOT EXISTS; the seed only overwrites rows
--            that are still unconfigured or still hold placeholders)
-- ============================================================

ALTER TABLE pharmacy_config
  ADD COLUMN IF NOT EXISTS payment_provider TEXT  NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS payment_details  JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN pharmacy_config.payment_provider
  IS 'How this tenant collects payment. v1 values: manual (bank transfer, staff verify). Future: paystack.';
COMMENT ON COLUMN pharmacy_config.payment_details
  IS 'Provider-specific config. manual: {bank_name, account_name, account_number}. Bank details are public-facing (shown to customers) — never store secrets here.';

-- ─── SEED: OCHESTA ───────────────────────────────────────────
-- Bank details are public-facing (customers transfer to this
-- account) — safe to commit. Targets the Ochesta tenant by name;
-- adjust the WHERE clause if the row is named differently
-- (check: SELECT id, pharmacy_name, widget_key FROM pharmacy_config;).
UPDATE pharmacy_config
SET payment_provider = 'manual',
    payment_details  = jsonb_build_object(
      'bank_name',      'GLOBUS BANK',
      'account_name',   'O''CHESTA PHARMA LTD',
      'account_number', '1000489343'
    )
WHERE pharmacy_name ILIKE '%ochesta%'
  AND (payment_details = '{}'::jsonb
       OR payment_details->>'bank_name' LIKE '<<FILL_ME%');
