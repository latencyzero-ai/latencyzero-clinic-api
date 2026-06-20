'use strict';

// ─── SUPABASE ADAPTER — OCHESTA BACKEND ───────────────────────────────────────
// Implements the BaseAdapter interface against Ochesta's Supabase project.
//
// Ochesta schema
// ──────────────
// products : id, name, category, description, price, stock_qty,
//            image_url, requires_prescription
//
// orders   : id TEXT ('OCP-XXXXXX'), customer_name, customer_phone,
//            customer_address TEXT NOT NULL,
//            total_amount NUMERIC, status TEXT ('pending'),
//            items JSONB {
//              cart         : [{product_id, name, price, quantity}],
//              customer_id  : string,          ← our Supabase UUID (for history lookup)
//              customer_email, delivery_address, delivery_city,
//              prescription_url, subtotal, delivery_fee, total,
//              payment_method
//            }
//
// Storage  : 'prescriptions' bucket, 'product-images' bucket
//
// Auth     : Supabase Auth — user_metadata: { firstName, lastName, phone }
//
// adapter_config shape (JSONB column in pharmacy_config; never returned to clients):
// {
//   "url"         : "https://<project>.supabase.co",
//   "service_key" : "eyJ..."   ← service_role key — server-side ONLY, never the anon key
// }
//
// SECURITY
// ────────
// • service_key is the Supabase SERVICE ROLE key.  It bypasses RLS.
// • It is read from adapter_config (our private DB column) — never hardcoded,
//   never logged, never returned in any API response.
// • All writes go through this server-side client.  The anon key is never used.
//
// Atomic stock decrement (install once in Supabase SQL editor — optional but
// strongly recommended for production):
//
//   CREATE OR REPLACE FUNCTION decrement_stock(items jsonb)
//   RETURNS void LANGUAGE plpgsql AS $$
//   DECLARE r jsonb;
//   BEGIN
//     FOR r IN SELECT * FROM jsonb_array_elements(items)
//     LOOP
//       UPDATE products
//         SET stock_qty = GREATEST(stock_qty - (r->>'qty')::int, 0)
//         WHERE id = (r->>'product_id');
//     END LOOP;
//   END; $$;
//
// Without the RPC the adapter falls back to per-item UPDATEs (not atomic).

const { BaseAdapter } = require('./interface');
const crypto = require('crypto');

function requireSupabase() {
  try {
    return require('@supabase/supabase-js');
  } catch {
    throw new Error(
      'SupabaseAdapter requires @supabase/supabase-js — run: npm install @supabase/supabase-js'
    );
  }
}

// Logs the COMPLETE Supabase error server-side (message + details + hint + code
// — these reveal RLS denials, missing columns, and JSONB shape problems) and
// returns an Error carrying the structured fields so upstream catches can log
// them too. User-facing replies stay generic; the server log carries the truth.
function supabaseError(method, error) {
  console.error(
    `[SupabaseAdapter.${method}]`,
    error.message,
    error.details || '',
    error.hint    || '',
    error.code    || ''
  );
  const err   = new Error(`SupabaseAdapter.${method}: ${error.message}`);
  err.details = error.details || null;
  err.hint    = error.hint    || null;
  err.code    = error.code    || null;
  return err;
}

// Decodes a Supabase JWT payload WITHOUT verifying the signature — just enough
// to read the "role" claim ('service_role' vs 'anon'). Never logs the key.
// New-style Supabase secret keys (sb_secret_...) are not JWTs but carry full
// service-level access — reported as 'sb_secret'. Returns null when the value
// is neither.
function decodeJwtRole(key) {
  if (typeof key === 'string' && key.startsWith('sb_secret_')) return 'sb_secret';
  try {
    const payload = JSON.parse(
      Buffer.from(key.split('.')[1], 'base64url').toString('utf8')
    );
    return payload.role || null;
  } catch {
    return null;
  }
}

// True when the key grants service-level (RLS-bypassing) access.
function isServiceLevel(role) {
  return role === 'service_role' || role === 'sb_secret';
}

class SupabaseAdapter extends BaseAdapter {
  constructor(adapterConfig) {
    super(adapterConfig);

    const { createClient } = requireSupabase();

    if (!adapterConfig.url) {
      throw new Error('SupabaseAdapter: adapter_config must include "url".');
    }

    // Resolve service role key.
    // Preferred: adapter_config.service_key_env holds the env-var NAME so the
    // key is never stored in the database. Fallback: adapter_config.service_key
    // for backwards compatibility with rows created before this convention.
    const serviceKey = adapterConfig.service_key_env
      ? process.env[adapterConfig.service_key_env]
      : adapterConfig.service_key;

    if (!serviceKey) {
      throw new Error(
        adapterConfig.service_key_env
          ? `SupabaseAdapter: env var "${adapterConfig.service_key_env}" is not set on this server. ` +
            `Add it in Render → Environment.`
          : 'SupabaseAdapter: adapter_config must include "service_key" or "service_key_env".'
      );
    }

    // Guard against the most common production mistake: the anon key (or a
    // malformed value) configured where the service_role key belongs. Writes
    // would then silently hit RLS. Logs the role claim only — never the key.
    const role = decodeJwtRole(serviceKey);
    if (!isServiceLevel(role)) {
      console.error(
        `[SupabaseAdapter] WARNING: resolved Supabase key has role "${role}" — NOT service_role. ` +
        `Writes (orders, stock, prescriptions) will fail under RLS. Check the key configured on Render.`
      );
    }

    // Service-role client — stateless, never persists a session.
    this._client = createClient(adapterConfig.url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  // ── IDENTITY ──────────────────────────────────────────────────────────────

  // Validates a Supabase JWT server-side using the service-role client.
  // Returns null for missing, expired, or invalid tokens.
  //
  // token → { externalUserId, name, email, phone } | null
  async verifyIdentity(token) {
    if (!token) return null;

    const { data, error } = await this._client.auth.getUser(token);
    if (error || !data?.user) return null;

    const u    = data.user;
    const meta = u.user_metadata || {};

    // Ochesta stores name split into firstName + lastName in user_metadata.
    const firstName = meta.firstName || meta.first_name  || '';
    const lastName  = meta.lastName  || meta.last_name   || '';
    const name      = [firstName, lastName].filter(Boolean).join(' ') || null;

    return {
      externalUserId : u.id,
      name           : name,
      email          : u.email                   || null,
      phone          : meta.phone || u.phone     || null,
    };
  }

  // ── CATALOGUE ─────────────────────────────────────────────────────────────

  // Returns Ochesta's product catalogue.
  // Ochesta's schema has no 'active' column — every row is live.
  // opts.query    : string — ilike filter on name
  // opts.category : string — exact match on category
  async getProducts({ query, category } = {}) {
    let q = this._client
      .from('products')
      .select('id, name, category, description, price, stock_qty, image_url, requires_prescription')
      .order('name', { ascending: true });

    if (category) q = q.eq('category', category);
    if (query)    q = q.ilike('name', `%${query}%`);

    const { data, error } = await q;
    if (error) throw supabaseError('getProducts', error);

    return (data || []).map(p => ({
      id                    : p.id,
      name                  : p.name,
      category              : p.category              || null,
      description           : p.description           || null,
      price                 : parseFloat(p.price),
      stock_qty             : p.stock_qty              ?? 0,
      image_url             : p.image_url              || null,
      requires_prescription : p.requires_prescription ?? false,
    }));
  }

  // Returns current stock_qty for a single product. Returns 0 if not found.
  async checkStock(productId) {
    const { data, error } = await this._client
      .from('products')
      .select('stock_qty')
      .eq('id', productId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return 0; // no row — treat as out of stock
      throw supabaseError('checkStock', error);
    }

    return data?.stock_qty ?? 0;
  }

  // ── PRESCRIPTION ──────────────────────────────────────────────────────────

  // Uploads to Ochesta's 'prescriptions' storage bucket.
  // Returns { url } — a publicly accessible URL for the uploaded file.
  //
  // file : { buffer: Buffer, mimetype: string, filename: string }
  async savePrescription(file) {
    const ext  = file.filename.includes('.') ? file.filename.split('.').pop() : 'bin';
    const path = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;

    const { data, error } = await this._client.storage
      .from('prescriptions')
      .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });

    if (error) throw supabaseError('savePrescription', error);

    const { data: urlData } = this._client.storage
      .from('prescriptions')
      .getPublicUrl(data.path);

    return { url: urlData.publicUrl };
  }

  // ── ORDERS ────────────────────────────────────────────────────────────────

  // Inserts a confirmed order into Ochesta's orders table.
  //
  // Key Ochesta differences from the generic interface:
  //   • id is a TEXT primary key generated here as 'OCP-XXXXXX'
  //   • items is a single JSONB column (no separate order_items table)
  //   • Ochesta cart items use {product_id, name, price, quantity} — not
  //     {product_id, name_snap, price_snap, qty}
  //   • total_amount (not total) is the top-level money field on the row
  //   • status is lowercase 'pending'
  //
  // Money totals (subtotal, delivery_fee, total) are computed in the calling
  // code and passed verbatim — this method does zero arithmetic.
  //
  // Standard interface fields (always required):
  //   orderObj.customer_id     — Supabase user UUID (embedded in items JSONB
  //                               as customer_id for order history lookup)
  //   orderObj.items[]         — {product_id, name_snap, price_snap, qty}
  //   orderObj.subtotal        — pre-computed
  //   orderObj.delivery_fee    — pre-computed (0 for PICKUP)
  //   orderObj.total           — pre-computed subtotal + delivery_fee
  //   orderObj.fulfilment      — 'DELIVERY' | 'PICKUP'
  //   orderObj.delivery_area   — area string or null
  //   orderObj.notes           — free text or null
  //
  // Extended Ochesta-specific fields (optional; null when not provided):
  //   orderObj.customer_name     — written to orders.customer_name
  //   orderObj.customer_phone    — written to orders.customer_phone
  //   orderObj.customer_email    — embedded in items JSONB
  //   orderObj.delivery_address  — embedded in items JSONB (falls back to delivery_area)
  //   orderObj.delivery_city     — embedded in items JSONB
  //   orderObj.prescription_url  — embedded in items JSONB
  //   orderObj.payment_method    — embedded in items JSONB
  async createOrder(orderObj) {
    // Map our interface cart shape → Ochesta's cart shape.
    // Our: { product_id, name_snap, price_snap, qty }
    // Ochesta: { product_id, name, price, quantity }
    const cart = orderObj.items.map(i => ({
      product_id : i.product_id,
      name       : i.name_snap,
      price      : i.price_snap,
      quantity   : i.qty,
    }));

    const itemsPayload = {
      cart,
      customer_id      : orderObj.customer_id,
      customer_email   : orderObj.customer_email    || null,
      delivery_address : orderObj.delivery_address  || orderObj.delivery_area || null,
      delivery_city    : orderObj.delivery_city      || null,
      delivery_landmark: orderObj.delivery_landmark  || null,
      prescription_url : orderObj.prescription_url   || null,
      subtotal         : orderObj.subtotal,
      delivery_fee     : orderObj.delivery_fee       || 0,
      total            : orderObj.total,
      payment_method   : orderObj.payment_method     || null,
    };

    // Generate a unique OCP-XXXXXX ID and retry on the rare duplicate collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const orderId = `OCP-${Math.floor(100000 + Math.random() * 900000)}`;

      // customer_address is NOT NULL in Ochesta's schema — always write a value,
      // even for pickup orders where no delivery address was collected.
      const customerAddress =
        orderObj.delivery_address ||
        orderObj.delivery_area ||
        (orderObj.fulfilment === 'PICKUP' ? 'PICKUP — collect in store' : 'Not provided');

      // customer_name is NOT NULL in Ochesta's schema (like customer_address) —
      // guest web-chat orders carry no name, so write an explicit marker staff
      // can recognise instead of letting the insert fail with 23502.
      const { data, error } = await this._client
        .from('orders')
        .insert({
          id               : orderId,
          customer_name    : orderObj.customer_name  || 'Guest (web chat)',
          customer_phone   : orderObj.customer_phone || null,
          customer_address : customerAddress,
          total_amount     : orderObj.total,
          status           : 'pending',
          items            : itemsPayload,
        })
        .select('id')
        .single();

      if (!error) return { orderId: data.id };

      // 23505 = unique_violation — another order already has this ID, try again.
      if (error.code === '23505') continue;

      throw supabaseError('createOrder', error);
    }

    throw new Error(
      'SupabaseAdapter.createOrder: failed to generate a unique OCP order ID after 5 attempts.'
    );
  }

  // Decrements products.stock_qty for every item in a confirmed order.
  //
  // Preferred path: calls the Supabase RPC 'decrement_stock' (atomic).
  // Fallback: individual UPDATE statements — not atomic; a partial failure
  // leaves stock inconsistent. Install the RPC to avoid this.
  //
  // items : Array<{ product_id: string | number, qty: number }>
  async decrementStock(items) {
    // Send BOTH 'qty' and 'quantity' so the decrement_stock RPC decrements
    // correctly whether its SQL reads item->>'qty' or item->>'quantity'.
    // (Our interface uses qty; the RPC has been written against quantity.)
    const rpcItems = items.map(i => ({ product_id: i.product_id, qty: i.qty, quantity: i.qty }));
    const { error: rpcErr } = await this._client.rpc('decrement_stock', { items: rpcItems });
    if (!rpcErr) return; // RPC succeeded — stock updated atomically

    console.warn(
      '[SupabaseAdapter] decrement_stock RPC unavailable — falling back to per-item UPDATEs ' +
      '(not atomic). Install the decrement_stock function in Supabase SQL editor to fix this. ' +
      `RPC error: ${rpcErr.message} ${rpcErr.details || ''} ${rpcErr.hint || ''} ${rpcErr.code || ''}`
    );

    for (const item of items) {
      const current = await this.checkStock(item.product_id);
      const newQty  = Math.max(current - item.qty, 0);

      const { error } = await this._client
        .from('products')
        .update({ stock_qty: newQty })
        .eq('id', item.product_id);

      if (error) {
        throw supabaseError(`decrementStock (product ${item.product_id})`, error);
      }
    }
  }

  // ── ORDER LOOKUP ──────────────────────────────────────────────────────────

  // Fetches a single Ochesta order by its 'OCP-XXXXXX' ID. Returns null when
  // the order doesn't exist.
  async getOrder(orderId) {
    const { data, error } = await this._client
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // no row
      throw supabaseError('getOrder', error);
    }
    return data;
  }

  // ── MANUAL PAYMENT CONFIRMATION ───────────────────────────────────────────

  // Marks an order 'paid' after pharmacy staff have verified the bank transfer
  // against their account. Ochesta's status vocabulary is lowercase:
  // 'pending' → 'paid'.
  //
  // paid_at stamping: the timestamp (and optional staff payment_ref) is always
  // merged into the items JSONB so it survives regardless of schema; the
  // update also tries Ochesta's top-level paid_at column, and falls back to
  // JSONB-only when that column doesn't exist (PostgREST PGRST204).
  //
  // Idempotent: the update is filtered on status != 'paid', so a double
  // confirm (or a race between two staff members) changes nothing and is
  // reported as { ok: false, reason: 'already_paid' }.
  async markOrderPaid(orderId, { paymentRef = null } = {}) {
    const existing = await this.getOrder(orderId);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (String(existing.status || '').toLowerCase() === 'paid') {
      return { ok: false, reason: 'already_paid', order: existing };
    }

    const paidAt = new Date().toISOString();
    const items  = {
      ...(existing.items || {}),
      paid_at     : paidAt,
      payment_ref : paymentRef || (existing.items || {}).payment_ref || null,
    };

    // Attempt 1: status + items + top-level paid_at column
    let { data, error } = await this._client
      .from('orders')
      .update({ status: 'paid', paid_at: paidAt, items })
      .eq('id', orderId)
      .neq('status', 'paid')
      .select()
      .single();

    // PGRST204 = unknown column in the update payload — Ochesta's orders
    // table has no paid_at column; the JSONB stamp inside items is enough.
    if (error && error.code === 'PGRST204') {
      ({ data, error } = await this._client
        .from('orders')
        .update({ status: 'paid', items })
        .eq('id', orderId)
        .neq('status', 'paid')
        .select()
        .single());
    }

    if (error) {
      if (error.code === 'PGRST116') {
        // Filter matched no row — another confirm won the race.
        return { ok: false, reason: 'already_paid' };
      }
      throw supabaseError('markOrderPaid', error);
    }

    return { ok: true, order: data };
  }

  // Adds stock back for the given items — reverse of decrementStock(). Used
  // by staff tools when deleting/cancelling an order whose stock was already
  // decremented at creation (v1 timing). Per-item read-then-update; not
  // atomic, which is acceptable for a low-contention admin action.
  //
  // items : Array<{ product_id: string | number, qty: number }>
  async incrementStock(items) {
    for (const item of items) {
      const current = await this.checkStock(item.product_id);
      const { error } = await this._client
        .from('products')
        .update({ stock_qty: current + Number(item.qty || 0) })
        .eq('id', item.product_id);

      if (error) {
        throw supabaseError(`incrementStock (product ${item.product_id})`, error);
      }
    }
  }

  // Permanently deletes an order row. Staff/admin tool only — never called
  // from the customer conversation flow.
  async deleteOrder(orderId) {
    const { data, error } = await this._client
      .from('orders')
      .delete()
      .eq('id', orderId)
      .select('id');

    if (error) throw supabaseError('deleteOrder', error);
    return { deleted: (data || []).length > 0 };
  }

  // ── ORDER HISTORY ─────────────────────────────────────────────────────────

  // Returns the 20 most recent orders for a customer.
  // Orders the Supabase UUID stored in items->>'customer_id' at creation time.
  // Returns [] (not null) when no orders are found.
  async getCustomerOrders(externalUserId) {
    const { data, error } = await this._client
      .from('orders')
      .select('id, customer_name, customer_phone, total_amount, status, items, created_at')
      .filter('items->>customer_id', 'eq', externalUserId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw supabaseError('getCustomerOrders', error);
    return data || [];
  }
}

module.exports = { SupabaseAdapter, decodeJwtRole, isServiceLevel };
