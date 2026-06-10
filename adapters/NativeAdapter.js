'use strict';

// ─── NATIVE ADAPTER (TODO) ────────────────────────────────────────────────────
// For greenfield clients who have no existing backend.
// Zero owns the domain tables (products, orders, inventory) in our own Postgres
// database. All reads and writes go through the shared pg Pool.
//
// adapter_config shape (stored in pharmacy_config.adapter_config JSONB):
// {
//   "currency": "NGN"         // optional; defaults to NGN
// }
//
// Required schema (will be added in a future migration):
//   products   : id, pharmacy_id, name, price, stock_qty, requires_prescription,
//                active, category, description, created_at
//   orders     : id, pharmacy_id, customer_id, status, subtotal, delivery_fee,
//                total, fulfilment, delivery_area, notes, created_at
//   order_items: id, order_id, product_id, name_snap, price_snap, qty

const { BaseAdapter } = require('./interface');

class NativeAdapter extends BaseAdapter {
  // pool : shared pg.Pool from the main process
  constructor(adapterConfig, pool) {
    super(adapterConfig);
    if (!pool) throw new Error('NativeAdapter requires a pg Pool instance.');
    this._pool        = pool;
    this._pharmacyId  = adapterConfig.pharmacy_id; // set by the loader
  }

  async verifyIdentity(_token) {
    // TODO: implement a lightweight token scheme (e.g. signed JWT with our
    // own secret, or a PIN issued at onboarding).
    throw new Error('NativeAdapter: verifyIdentity() not yet implemented.');
  }

  async getProducts(_opts) {
    // TODO: SELECT from products WHERE pharmacy_id = this._pharmacyId AND active = true
    throw new Error('NativeAdapter: getProducts() not yet implemented.');
  }

  async checkStock(productId) {
    // TODO: SELECT stock_qty FROM products WHERE id = $1 AND pharmacy_id = $2
    void productId;
    throw new Error('NativeAdapter: checkStock() not yet implemented.');
  }

  async savePrescription(_file) {
    // TODO: upload to an S3-compatible bucket (Render Disk or Cloudflare R2)
    // and return the URL.
    throw new Error('NativeAdapter: savePrescription() not yet implemented.');
  }

  async createOrder(_orderObj) {
    // TODO: INSERT into orders + order_items within a transaction.
    throw new Error('NativeAdapter: createOrder() not yet implemented.');
  }

  async decrementStock(_items) {
    // TODO: UPDATE products SET stock_qty = GREATEST(stock_qty - $qty, 0)
    // inside a transaction for each item.
    throw new Error('NativeAdapter: decrementStock() not yet implemented.');
  }

  async getCustomerOrders(_externalUserId) {
    // TODO: SELECT orders + order_items WHERE customer_id = $1 AND pharmacy_id = $2
    throw new Error('NativeAdapter: getCustomerOrders() not yet implemented.');
  }
}

module.exports = { NativeAdapter };
