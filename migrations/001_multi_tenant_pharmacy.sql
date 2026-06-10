-- ============================================================
-- Migration: 001_multi_tenant_pharmacy
-- Purpose  : Multi-tenant pharmacy platform tables
-- Run via  : pgAdmin against Render Postgres external string
-- Safe to  : re-run (all statements use IF NOT EXISTS / IF EXISTS)
-- ============================================================

-- ─── PHARMACY TENANT CONFIG ──────────────────────────────────
-- One row per pharmacy. phone_number_id is the Meta WABA phone
-- number identifier used to route incoming webhooks.
CREATE TABLE IF NOT EXISTS pharmacy_config (
  id               SERIAL        PRIMARY KEY,
  pharmacy_name    VARCHAR(255)  NOT NULL,
  whatsapp_number  VARCHAR(50),
  phone_number_id  VARCHAR(100)  NOT NULL UNIQUE,
  waba_id          VARCHAR(100),
  currency         VARCHAR(10)   NOT NULL DEFAULT 'NGN',
  delivery_fee     NUMERIC(10,2) NOT NULL DEFAULT 0,
  delivery_note    TEXT,
  payment_provider VARCHAR(50)   NOT NULL DEFAULT 'paystack',
  active           BOOLEAN       NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ─── PRODUCT CATALOGUE ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id           SERIAL        PRIMARY KEY,
  pharmacy_id  INTEGER       NOT NULL REFERENCES pharmacy_config(id) ON DELETE CASCADE,
  name         VARCHAR(255)  NOT NULL,
  description  TEXT,
  price        NUMERIC(10,2) NOT NULL,
  stock_qty    INTEGER       NOT NULL DEFAULT 0,
  low_stock_at INTEGER       NOT NULL DEFAULT 5,
  rx_required  BOOLEAN       NOT NULL DEFAULT false,
  active       BOOLEAN       NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Partial index: fast lookup of active products per pharmacy
-- (the WHERE predicate matches the active = true filter in every catalog query)
CREATE INDEX IF NOT EXISTS idx_products_pharmacy_active
  ON products (pharmacy_id)
  WHERE active = true;

-- ─── ORDERS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL        PRIMARY KEY,
  pharmacy_id     INTEGER       NOT NULL REFERENCES pharmacy_config(id),
  conversation_id VARCHAR(100),
  customer_phone  VARCHAR(50)   NOT NULL,
  customer_name   VARCHAR(255),
  status          VARCHAR(50)   NOT NULL DEFAULT 'PENDING',
  fulfilment      VARCHAR(50)   NOT NULL DEFAULT 'DELIVERY',
  subtotal        NUMERIC(10,2),
  delivery_fee    NUMERIC(10,2),
  total           NUMERIC(10,2),
  payment_ref     VARCHAR(255),
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_pharmacy_status
  ON orders (pharmacy_id, status);

-- ─── ORDER LINE ITEMS ─────────────────────────────────────────
-- name_snap / price_snap preserve the product name and price at
-- the moment the order was placed (products may change later).
CREATE TABLE IF NOT EXISTS order_items (
  id          SERIAL        PRIMARY KEY,
  order_id    INTEGER       NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  INTEGER       NOT NULL REFERENCES products(id),
  name_snap   VARCHAR(255)  NOT NULL,
  price_snap  NUMERIC(10,2) NOT NULL,
  qty         INTEGER       NOT NULL DEFAULT 1
);

-- ─── INVENTORY CHANGE LOG ─────────────────────────────────────
-- change is negative for stock consumed (order), positive for
-- restocks. order_id is nullable (manual adjustments have no order).
CREATE TABLE IF NOT EXISTS inventory_log (
  id          SERIAL      PRIMARY KEY,
  product_id  INTEGER     NOT NULL REFERENCES products(id),
  change      INTEGER     NOT NULL,
  reason      TEXT,
  order_id    INTEGER     REFERENCES orders(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── PHARMACY CONVERSATIONS ───────────────────────────────────
-- Separate from the clinic conversations table so pharmacy and
-- clinic state machines never share rows, even for the same
-- customer phone number.
CREATE TABLE IF NOT EXISTS pharmacy_conversations (
  id          SERIAL      PRIMARY KEY,
  pharmacy_id INTEGER     NOT NULL REFERENCES pharmacy_config(id),
  phone       VARCHAR(50) NOT NULL,
  state       VARCHAR(50) NOT NULL DEFAULT 'START',
  data        JSONB                DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pharmacy_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_conversations_phone
  ON pharmacy_conversations (phone);
