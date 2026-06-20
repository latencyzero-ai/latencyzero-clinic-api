-- 006_delivery_zones.sql
-- Zone-based delivery pricing (no maps API). Each tenant defines named areas and
-- a flat fee per area; the order flow matches the customer's typed area against a
-- zone name and uses that fee. When delivery_zones is empty/unset, the flow falls
-- back to the existing flat pharmacy_config.delivery_fee, so this is backward-safe.
--
-- Shape:
--   { "zones": [ {"name":"Ikeja","fee":500}, {"name":"Lekki","fee":1500} ],
--     "default_fee": 1000 }
-- "default_fee" is charged when the customer's area matches no zone. Names that
-- still contain a '<<...>>' placeholder are ignored by the resolver.

ALTER TABLE pharmacy_config
  ADD COLUMN IF NOT EXISTS delivery_zones JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN pharmacy_config.delivery_zones
  IS 'Zone-based delivery pricing: {zones:[{name,fee}], default_fee}. Empty {} = use flat delivery_fee. Area match is loose substring (case-insensitive). PUBLIC-SAFE: no secrets.';
