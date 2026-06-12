'use strict';

// ─── ADAPTER INTERFACE ────────────────────────────────────────────────────────
// BaseAdapter defines the contract every backend adapter must satisfy.
// Zero's core calls ONLY these methods — it never touches a specific backend SDK.
//
// Concrete implementations live alongside this file (SupabaseAdapter,
// NativeAdapter, …). The loader in ./index.js picks one by adapter_type.
//
// All methods are async and must either resolve or throw. Throwing is preferred
// over returning null/undefined so callers can distinguish "not found" (return [])
// from "backend error" (throw).

class BaseAdapter {
  constructor(adapterConfig) {
    if (new.target === BaseAdapter) {
      throw new Error('BaseAdapter is abstract — instantiate a concrete adapter class.');
    }
    this.config = adapterConfig;
  }

  // ── IDENTITY ──────────────────────────────────────────────────────────────

  // Validate an inbound user token and return a normalised identity object.
  // Returns null if the token is missing, expired, or invalid.
  //
  // token  : string — JWT, session token, or whatever the auth_mode dictates
  // →      : { externalUserId: string, name: string|null, email: string|null, phone: string|null }
  //          | null
  async verifyIdentity(token) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}: verifyIdentity() not implemented.`);
  }

  // ── CATALOGUE ─────────────────────────────────────────────────────────────

  // Return the active product catalogue, optionally filtered.
  // Returned objects must include at minimum: id, name, price, stock_qty,
  // requires_prescription. Extra fields (category, description, image_url)
  // are passed through as-is.
  //
  // opts.query    : string — free-text search applied to product name
  // opts.category : string — exact category filter
  // →             : Array<{ id, name, price: number, stock_qty: number,
  //                          requires_prescription: boolean, ...rest }>
  async getProducts(opts = {}) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}: getProducts() not implemented.`);
  }

  // Return current stock quantity for a single product.
  // Used for the "only N left" guard before adding to cart.
  //
  // productId : string | number
  // →         : number (0 if the product doesn't exist)
  async checkStock(productId) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}: checkStock() not implemented.`);
  }

  // ── PRESCRIPTION ──────────────────────────────────────────────────────────

  // Upload a prescription file to the client's storage backend.
  // Returns a publicly accessible (or signed) URL for later review.
  //
  // file : { buffer: Buffer, mimetype: string, filename: string }
  // →    : { url: string }
  async savePrescription(file) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}: savePrescription() not implemented.`);
  }

  // ── ORDERS ────────────────────────────────────────────────────────────────

  // Write a confirmed order to the client's backend. Called after the user
  // confirms the order summary (before payment is collected).
  // Zero never constructs order IDs — the client backend owns that sequence.
  //
  // orderObj : {
  //   customer_id    : string,          // externalUserId
  //   items          : Array<{
  //     product_id   : string | number,
  //     name_snap    : string,          // product name at order time
  //     price_snap   : number,          // price at order time
  //     qty          : number,
  //   }>,
  //   subtotal       : number,
  //   delivery_fee   : number,
  //   total          : number,
  //   fulfilment     : 'DELIVERY' | 'PICKUP',
  //   delivery_area  : string | null,
  //   notes          : string | null,
  // }
  // →        : { orderId: string | number }
  async createOrder(orderObj) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}: createOrder() not implemented.`);
  }

  // Atomically decrement stock for all items in a confirmed order.
  // Called immediately after createOrder(). Must be transactional — partial
  // decrements are worse than none. Use an RPC / stored procedure if the
  // client backend supports it.
  //
  // items : Array<{ product_id: string | number, qty: number }>
  // →     : void
  async decrementStock(items) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}: decrementStock() not implemented.`);
  }

  // Fetch a single order by its backend ID.
  // Returns null when no order with that ID exists.
  //
  // orderId : string | number
  // →       : order (backend-specific shape) | null
  async getOrder(orderId) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}: getOrder() not implemented.`);
  }

  // Mark an order as paid after STAFF have verified the payment out-of-band
  // (v1: a manual bank transfer checked against the pharmacy's bank account).
  // Must be idempotent: confirming an already-paid order is a no-op reported
  // via { ok: false, reason: 'already_paid' } — never a double state change.
  // Status value must match the client backend's own vocabulary
  // (e.g. Ochesta uses lowercase 'pending' → 'paid').
  //
  // orderId : string | number
  // opts    : { paymentRef?: string|null } — optional staff-supplied reference
  // →       : { ok: true,  order }                              on success
  //           { ok: false, reason: 'not_found' | 'already_paid', order? }
  async markOrderPaid(orderId, opts = {}) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}: markOrderPaid() not implemented.`);
  }

  // ── ORDER HISTORY ─────────────────────────────────────────────────────────

  // Return recent orders for a customer. Used for the "track order" intent
  // and to surface reorder suggestions. Return [] (not null) if none found.
  //
  // externalUserId : string
  // →              : Array<order> (shape is backend-specific; passed through as-is)
  async getCustomerOrders(externalUserId) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}: getCustomerOrders() not implemented.`);
  }
}

module.exports = { BaseAdapter };
