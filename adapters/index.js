'use strict';

// ─── ADAPTER LOADER ───────────────────────────────────────────────────────────
// Selects and instantiates the correct adapter implementation based on the
// adapter_type column in pharmacy_config.
//
// Usage:
//   const { loadAdapter } = require('./adapters');
//   const adapter = loadAdapter(pharmacyConfigRow, pool);
//   const products = await adapter.getProducts({ query: 'paracetamol' });
//
// Adding a new adapter:
//   1. Create adapters/YourAdapter.js extending BaseAdapter
//   2. Add a case below
//   3. Add the adapter_type string to the pharmacy_config.adapter_type CHECK
//      constraint (or document it) so operators know valid values

const { SupabaseAdapter } = require('./SupabaseAdapter');
const { NativeAdapter   } = require('./NativeAdapter');

// pharmacyConfigRow : a full row from pharmacy_config (id, adapter_type, adapter_config, …)
// pool              : pg.Pool — passed through to adapters that need direct DB access (NativeAdapter)
//                     Ignored by adapters that manage their own connection (SupabaseAdapter).
function loadAdapter(pharmacyConfigRow, pool) {
  const { adapter_type, adapter_config, id } = pharmacyConfigRow;

  if (!adapter_type) {
    throw new Error('loadAdapter: pharmacy_config row is missing adapter_type.');
  }

  const config = {
    ...(adapter_config || {}),
    pharmacy_id: id, // injected so adapters that need it don't have to ask
  };

  switch (adapter_type) {
    case 'supabase':
      return new SupabaseAdapter(config);

    case 'native':
      return new NativeAdapter(config, pool);

    default:
      throw new Error(
        `loadAdapter: unknown adapter_type "${adapter_type}". ` +
        `Supported values: supabase, native.`
      );
  }
}

module.exports = { loadAdapter };
