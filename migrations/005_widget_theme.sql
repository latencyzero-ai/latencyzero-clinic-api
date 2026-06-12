-- ============================================================
-- Migration: 005_widget_theme
-- Purpose  : Per-tenant widget branding — the widget follows
--            each pharmacy's brand via config, never a code fork.
--
--            theme JSONB keys (ALL optional — any missing key
--            falls back to the widget's built-in defaults):
--              accent           — primary brand color (buttons, icons)
--              ink              — main text / dark brand color
--              surface          — panel & card background
--              canvas           — chat area background
--              userBubble       — customer message bubble background
--              fontFamily       — CSS font-family stack
--              logoUrl          — https URL to a square logo image
--              agentDisplayName — assistant name shown in the widget
--
-- Run via  : pgAdmin against Render Postgres external string
-- Prereqs  : Migration 003 (004 not required)
-- Safe to  : re-run (IF NOT EXISTS; no data is modified)
-- ============================================================

ALTER TABLE pharmacy_config
  ADD COLUMN IF NOT EXISTS theme JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN pharmacy_config.theme
  IS 'Per-tenant widget branding: {accent, ink, surface, canvas, userBubble, fontFamily?, logoUrl?, agentDisplayName?}. All keys optional — missing keys use widget defaults. PUBLIC-SAFE: returned verbatim by GET /api/web/widget-config; never store secrets here.';
