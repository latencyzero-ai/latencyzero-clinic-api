-- ============================================================
-- Migration: 003_adapter_architecture
-- Purpose  : Switch to backend-agnostic adapter layer.
--            Removes domain tables (products, orders, inventory)
--            from our DB — these now live in each client's own
--            backend and are accessed through the adapter interface.
--            Replaces pharmacy_config and pharmacy_conversations
--            with adapter-aware schemas.
--
-- Run via  : pgAdmin against Render Postgres external string
-- Prereqs  : Migrations 001 and 002 must have been applied.
--            If starting fresh, run all three in order.
-- Safe to  : re-run (wrapped in a transaction; idempotent drops)
-- ============================================================

BEGIN;

-- ─── 1. REMOVE DOMAIN TABLES ─────────────────────────────────
-- These tables move into each client's own backend.
-- Zero never owns product catalogue, orders, or inventory.
DROP TABLE IF EXISTS inventory_log         CASCADE;
DROP TABLE IF EXISTS order_items           CASCADE;
DROP TABLE IF EXISTS orders                CASCADE;
DROP TABLE IF EXISTS products              CASCADE;

-- ─── 2. DROP OLD ORCHESTRATION TABLES ────────────────────────
-- Old schema tied config to a single WhatsApp phone_number_id
-- and conversations to a phone number. Both are replaced below.
DROP TABLE IF EXISTS pharmacy_conversations CASCADE;
DROP TABLE IF EXISTS pharmacy_config        CASCADE;

-- ─── 3. PHARMACY TENANT CONFIG ───────────────────────────────
-- One row per pharmacy tenant. Zero stores orchestration config
-- only — no domain data, no payment credentials in plaintext.
--
-- adapter_type  selects which adapter class is instantiated
--               (supabase | native).
-- adapter_config holds the adapter's connection details (Supabase
--               URL + service key, table name overrides, etc.).
--               This column is NEVER returned to the client.
-- auth_mode     controls how inbound user tokens are verified
--               (supabase_jwt | none).
-- widget_key    is the public identifier embedded in the chat
--               widget. Sent on every request to identify the tenant.
-- handoff_number is an optional WhatsApp number for human handoff.
CREATE TABLE pharmacy_config (
  id             SERIAL          PRIMARY KEY,
  pharmacy_name  TEXT            NOT NULL,
  widget_key     TEXT            NOT NULL UNIQUE,
  timezone       TEXT            NOT NULL DEFAULT 'Africa/Lagos',
  adapter_type   TEXT            NOT NULL DEFAULT 'supabase',
  adapter_config JSONB           NOT NULL DEFAULT '{}',
  auth_mode      TEXT            NOT NULL DEFAULT 'supabase_jwt',
  handoff_number TEXT,
  delivery_fee   NUMERIC(10, 2)  NOT NULL DEFAULT 0,
  active         BOOLEAN         NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN pharmacy_config.widget_key
  IS 'Public tenant key embedded in the chat widget — sent on every request.';
COMMENT ON COLUMN pharmacy_config.adapter_type
  IS 'Selects the adapter implementation. Values: supabase | native.';
COMMENT ON COLUMN pharmacy_config.adapter_config
  IS 'Adapter credentials and table mappings. Never exposed outside the server.';
COMMENT ON COLUMN pharmacy_config.auth_mode
  IS 'Token verification strategy. Values: supabase_jwt | none.';
COMMENT ON COLUMN pharmacy_config.handoff_number
  IS 'WhatsApp number for human escalation handoffs. Optional.';

-- ─── 4. PHARMACY CONVERSATIONS ───────────────────────────────
-- Stores Zero conversation state and history. Domain intent (cart
-- contents, pending product, delivery details) lives in the JSONB
-- state column — not in separate tables.
--
-- external_user_id is the user's identifier in the client's backend
-- (e.g. Supabase auth UUID). For anonymous sessions, the widget
-- generates a client-side UUID and sends it as a bearer token.
--
-- history is capped at 30 turns on every write to bound row size.
CREATE TABLE pharmacy_conversations (
  id               SERIAL      PRIMARY KEY,
  pharmacy_id      INTEGER     NOT NULL REFERENCES pharmacy_config(id) ON DELETE CASCADE,
  external_user_id TEXT        NOT NULL,
  channel          TEXT        NOT NULL DEFAULT 'web',
  state            JSONB       NOT NULL DEFAULT '{}',
  history          JSONB       NOT NULL DEFAULT '[]',
  status           TEXT        NOT NULL DEFAULT 'ACTIVE',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary lookup: resolve a conversation for a given user in a given pharmacy.
CREATE UNIQUE INDEX idx_pharmacy_conv_lookup
  ON pharmacy_conversations (pharmacy_id, external_user_id);

COMMENT ON COLUMN pharmacy_conversations.external_user_id
  IS 'User ID from the client backend. For anonymous sessions: a client-generated UUID.';
COMMENT ON COLUMN pharmacy_conversations.channel
  IS 'Originating channel. Values: web | whatsapp | sms.';
COMMENT ON COLUMN pharmacy_conversations.state
  IS 'Active order state: phase, cart, pending product, rx status, fulfilment, etc.';
COMMENT ON COLUMN pharmacy_conversations.history
  IS 'Conversation turns [{role, content, timestamp}]. Max 30 entries.';
COMMENT ON COLUMN pharmacy_conversations.status
  IS 'Lifecycle status. Values: ACTIVE | DONE | ABANDONED.';

COMMIT;
