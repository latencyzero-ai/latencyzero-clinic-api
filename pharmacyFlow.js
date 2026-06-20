'use strict';

// ─── PHARMACY CONVERSATION ENGINE ────────────────────────────────────────────
// Adapter-agnostic pharmacy conversation flow. Works for any adapter_type
// (supabase, native, …) because it calls only the BaseAdapter interface.
//
// State machine (stored in pharmacy_conversations):
//   START → MENU → ACTIVE → DONE
//
// Phases within ACTIVE:
//   Order flow    : product → qty → rx_confirm → more_or_checkout → delivery → confirm
//   Consultation  : consult_collect
//   Enquiry       : enquiry_collect
//
// Usage (index.js):
//   const { createPharmacyProcessor } = require('./pharmacyFlow');
//   const pharmFlow = createPharmacyProcessor({ pool, groq, io, addLog,
//                       sendWhatsApp, getGreeting, META_API, ACCESS_TOKEN });
//   const reply = await pharmFlow.processPharmacyMessage(
//                   externalUserId, message, mediaAttachment, pharmacyConfig, adapter);
//
// mediaAttachment : { mediaId, mediaMime, mediaFilename } | null
//   — passed when the inbound WhatsApp message is an image or document.
//   — pharmacyFlow downloads + uploads it via adapter.savePrescription()

const axios = require('axios');

const HISTORY_CAP = 30; // matches pharmacy_conversations.history comment in migration 003

// ─── UTILITIES (self-contained; no import from index.js) ──────────────────────

function formatCurrency(amount, currency) {
  const sym = { NGN: '₦', USD: '$', GHS: '₵', KES: 'KSh' }[currency] || (currency + ' ');
  return `${sym}${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function fuzzyMatch(query, products) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const q = norm(query);
  const qWords = q.split(/\s+/).filter(w => w.length > 2);
  return products
    .map(p => {
      const n = norm(p.name);
      let score = 0;
      if (n === q) score = 100;
      else if (n.includes(q) || q.includes(n)) score = 80;
      else {
        const nWords = n.split(/\s+/);
        const hits = qWords.filter(w => nWords.some(nw => nw.startsWith(w) || w.startsWith(nw)));
        score = qWords.length ? (hits.length / qWords.length) * 60 : 0;
      }
      return { ...p, _score: score };
    })
    .filter(p => p._score > 25)
    .sort((a, b) => b._score - a._score);
}

// Returns "Good morning / afternoon / evening" in the pharmacy's local timezone.
function getDaypart(timezone) {
  try {
    const h = parseInt(
      new Date().toLocaleString('en-US', {
        timeZone: timezone || 'Africa/Lagos',
        hour    : 'numeric',
        hour12  : false,
      }),
      10
    );
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  } catch {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }
}

// Compact, non-diagnostic order summary for in-session reorder context.
// Stores: order ID, date, item names + quantities, total amount ONLY.
// Delivery address, notes, and diagnostic fields are deliberately excluded.
function formatRecentOrders(orders) {
  return (orders || []).slice(0, 3).map(o => {
    const cart = o.items?.cart || [];
    return {
      id   : o.id,
      date : (o.created_at || '').split('T')[0] || null,
      items: cart
        .map(i => ({ product_id: i.product_id, name: i.name || i.name_snap, qty: Number(i.quantity || i.qty || 1) }))
        .filter(i => i.name),
      total: Number(o.total_amount || o.items?.total || 0),
    };
  }).filter(o => o.items.length > 0);
}

// ─── MANUAL PAYMENT (v1: bank transfer, no gateway) ───────────────────────────

// True when the customer message claims a payment was made ("I've paid",
// "transfer done", "sent the money"). Checked BEFORE menu keyword routing —
// "I paid for my order" contains "order" and would otherwise start a new
// order flow.
function isPaymentClaim(rawMsg) {
  const m = (rawMsg || '').toLowerCase();
  if (/\bpaid\b/.test(m)) return true;
  if (/\btransferred\b/.test(m)) return true;
  return /\b(made|sent|done|completed|finished)\b/.test(m) && /\b(payment|transfer)\b/.test(m);
}

// True when a message looks like a main-menu choice (number or keyword). Used
// to route a customer straight back into a flow from the DONE state — e.g. when
// they tap "1. Place an order" from the post-order "anything else?" prompt —
// instead of replaying the welcome. Mirrors the MENU block's own triggers.
function isMenuSelection(rawMsg) {
  const m = (rawMsg || '').trim().toLowerCase();
  if (!m) return false;
  if (['1', '2', '3'].includes(m)) return true;
  if (m.includes('same as last') || m.includes('last order') || m.includes('order again')) return true;
  return /\b(order|buy|purchase|need|reorder|consult|appointment|book|enquir|question|ask)\b/.test(m)
    || m.includes('see a doctor');
}

// ─── DELIVERY: ZONE-BASED FEE (no maps API) ───────────────────────────────────
// pharmacy_config.delivery_zones (JSONB, migration 006):
//   { "zones": [ {"name":"Ikeja","fee":500}, ... ], "default_fee": 1000 }
// Matches the customer's typed area against a zone name (loose substring match,
// either direction) and returns that zone's fee. Unmatched areas use default_fee
// when set. When delivery_zones is absent/unfilled, falls back to the flat
// pharmacy_config.delivery_fee — so existing tenants keep working unchanged.
// Returns { fee:Number, zone:String|null, matched:Boolean }.
function resolveDeliveryFee(area, pharmacyConfig) {
  const cfg   = pharmacyConfig.delivery_zones;
  const zones = cfg && Array.isArray(cfg.zones)
    ? cfg.zones.filter(z => z && typeof z.name === 'string' && !/<<.*>>/.test(z.name))
    : [];
  if (zones.length) {
    const a = (area || '').trim().toLowerCase();
    if (a) {
      const match = zones.find(z => {
        const zn = z.name.trim().toLowerCase();
        return a === zn || a.includes(zn) || zn.includes(a);
      });
      if (match) return { fee: Number(match.fee) || 0, zone: match.name, matched: true };
    }
    if (cfg.default_fee != null) return { fee: Number(cfg.default_fee) || 0, zone: null, matched: false };
  }
  return { fee: parseFloat(pharmacyConfig.delivery_fee) || 0, zone: null, matched: false };
}

// Example zone names (real, unfilled placeholders excluded) to hint the customer
// when asking which area to deliver to. Empty string when none are configured.
function zoneHint(pharmacyConfig) {
  const cfg   = pharmacyConfig.delivery_zones;
  const names = cfg && Array.isArray(cfg.zones)
    ? cfg.zones.map(z => z && z.name).filter(n => typeof n === 'string' && !/<<.*>>/.test(n))
    : [];
  return names.length ? ` For example: ${names.slice(0, 4).join(', ')}.` : '';
}

// ─── SEQUENTIAL FIELD COLLECTORS (delivery / consultation / enquiry) ──────────
// Each returns the next field to ask for as { awaiting, prompt }, or null when
// every required field is present. The caller records the answer to whatever it
// last asked (state.*_awaiting), then calls this for the next prompt — so an
// invalid/blank answer simply leaves the field unset and re-asks the same one.

function deliveryNextPrompt(d, pharmacyConfig) {
  if (!d.name)    return { awaiting: 'name',    prompt: `Who should we deliver to? Please share the full name.` };
  if (!d.phone)   return { awaiting: 'phone',   prompt: `What phone number should the rider call?` };
  if (!d.address) return { awaiting: 'address', prompt: `What's the full delivery address? Please include the street and house/apartment number.` };
  if (!d.area)    return { awaiting: 'area',    prompt: `Which area or zone should we deliver to?${zoneHint(pharmacyConfig)}` };
  if (!d.landmark_asked) return { awaiting: 'landmark', prompt: `Any nearby landmark to help the rider find you? Reply with one, or *skip*.` };
  return null;
}

function consultNextPrompt(c) {
  if (!c.name)  return { awaiting: 'name',  prompt: `I can set that up with our pharmacist. What's your full name?` };
  if (!c.phone) return { awaiting: 'phone', prompt: `What's the best phone number for the pharmacist to reach you on?` };
  if (!c.about) return { awaiting: 'about', prompt: `Briefly, what would you like to consult about?` };
  if (!c.time)  return { awaiting: 'time',  prompt: `When are you available? Share a preferred day and time.` };
  if (c.on_meds == null) return { awaiting: 'meds', prompt: `Are you currently taking any medication? Reply *yes* (and what), or *no*.` };
  return null;
}

function enquiryNextPrompt(e) {
  if (!e.question) return { awaiting: 'question', prompt: `Sure — what's your question?` };
  if (!e.name)     return { awaiting: 'name',     prompt: `Happy to get that answered for you. What's your name?` };
  if (!e.contact)  return { awaiting: 'contact',  prompt: `And the best way to reach you — a phone number or email?` };
  return null;
}

// Builds the bank-transfer instruction block from pharmacy_config
// (migration 004: payment_details JSONB {bank_name, account_name,
// account_number}). Returns null when manual payment isn't configured —
// the caller falls back to "our team will be in touch". Unfilled
// '<<FILL_ME' seed placeholders count as NOT configured so they are
// never shown to a customer.
function buildPaymentInstructions(pharmacyConfig, orderId, total, currency) {
  if ((pharmacyConfig.payment_provider || 'manual') !== 'manual') return null;

  const pd     = pharmacyConfig.payment_details || {};
  const filled = v => v && !String(v).includes('<<FILL_ME');

  if (filled(pd.bank_name) && filled(pd.account_name) && filled(pd.account_number)) {
    return (
      `Please pay by bank transfer:\n\n` +
      `Bank: ${pd.bank_name}\n` +
      `Account name: ${pd.account_name}\n` +
      `Account number: ${pd.account_number}\n` +
      `Amount: ${formatCurrency(total, currency)} (please transfer the exact amount)\n\n` +
      `IMPORTANT: Use your order ID *${orderId}* as the transfer reference/narration so the pharmacy can match your payment.`
    );
  }

  // Legacy free-text details (pre-004 manual_payment_details column)
  if (pharmacyConfig.manual_payment_details) {
    return (
      `Please make payment via:\n${pharmacyConfig.manual_payment_details}\n\n` +
      `Use your order ID *${orderId}* as the transfer reference/narration.`
    );
  }

  return null;
}

// Deterministic reply when a customer says they've paid. Server-side only —
// NEVER changes order status and NEVER says the payment was received. Only
// staff confirm transfers, via
// POST /api/pharmacy/:widgetKey/orders/:orderId/confirm-payment.
function buildPaymentClaimReply(state, pharmacyConfig) {
  const orderRef = state.last_order_id ? ` for order *${state.last_order_id}*` : '';
  let reply =
    `Thank you for letting us know. The pharmacy team will check their account and verify your transfer${orderRef} shortly — ` +
    `your order will be processed as soon as they confirm it on their end. I'm not able to confirm payments myself.`;
  reply += pharmacyConfig.handoff_number
    ? `\n\nIf it's urgent, you can reach the pharmacy directly on WhatsApp: https://wa.me/${pharmacyConfig.handoff_number.replace(/[^0-9]/g, '')}`
    : `\n\nIf it's urgent, send us an enquiry and a staff member will assist you.`;
  return reply;
}

// ─── FACTORY ──────────────────────────────────────────────────────────────────

function createPharmacyProcessor({ pool, groq, io, addLog, sendWhatsApp, getGreeting, META_API, ACCESS_TOKEN }) {

  // ── CONVERSATION PERSISTENCE ─────────────────────────────────────────────
  // Uses pharmacy_conversations schema from migration 003:
  //   state JSONB  — machine + phase + cart + collected data
  //   history JSONB — [{role, content, timestamp}] (capped at HISTORY_CAP)
  //   status TEXT   — 'ACTIVE' | 'DONE' | 'ABANDONED'

  async function getConv(externalUserId, pharmacyId) {
    const res = await pool.query(
      'SELECT * FROM pharmacy_conversations WHERE external_user_id = $1 AND pharmacy_id = $2',
      [externalUserId, pharmacyId]
    );
    if (res.rows.length === 0) {
      const ins = await pool.query(
        `INSERT INTO pharmacy_conversations (pharmacy_id, external_user_id, state, history)
         VALUES ($1, $2, $3, '[]'::jsonb) RETURNING *`,
        [pharmacyId, externalUserId, JSON.stringify({ machine: 'START' })]
      );
      return ins.rows[0];
    }
    return res.rows[0];
  }

  async function saveConv(externalUserId, pharmacyId, state, history, dbStatus) {
    await pool.query(
      `UPDATE pharmacy_conversations
       SET state = $1, history = $2, status = $3, updated_at = NOW()
       WHERE external_user_id = $4 AND pharmacy_id = $5`,
      [
        JSON.stringify(state),
        JSON.stringify(history.slice(-HISTORY_CAP)),
        dbStatus || 'ACTIVE',
        externalUserId,
        pharmacyId,
      ]
    );
  }

  // ── MEDIA DOWNLOAD ────────────────────────────────────────────────────────
  // Downloads a Meta WhatsApp media object as a Buffer.

  async function downloadMedia(mediaId) {
    const info = await axios.get(`${META_API}/${mediaId}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    const file = await axios.get(info.data.url, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      responseType: 'arraybuffer',
    });
    return Buffer.from(file.data);
  }

  // ── PHARMACY AI ───────────────────────────────────────────────────────────
  // Order-scoped only. Never invents products, prices, or medical advice.
  // History is stripped to {role, content} before the API call (no timestamps).
  // Markdown fences are stripped before JSON.parse.

  async function pharmacyAI(message, history, stateData, products, pharmacyName, recentOrders) {
    const productList = products.length
      ? products.map(p =>
          `  ${p.name}  (${p.requires_prescription ? 'Rx required' : 'OTC'}, ` +
          `${p.stock_qty > 0 ? 'in stock' : 'OUT OF STOCK'})`
        ).join('\n')
      : '  No products currently available.';

    const snap = {
      phase          : stateData.phase || 'product',
      product        : stateData.product_id ? stateData.product_name : null,
      qty            : stateData.qty        || null,
      requires_rx    : stateData.product_requires_prescription || false,
      rx_confirmed   : stateData.rx_confirmed ?? null,
      cart_count     : (stateData.cart || []).length,
      fulfilment     : stateData.fulfilment  || null,
      delivery_area  : stateData.delivery_area || null,
    };

    const orders = (recentOrders || []);
    const orderHistorySection = orders.length
      ? `\nCUSTOMER'S RECENT ORDERS (reference for reorder suggestions only — do not add medical context):\n` +
        orders.map((o, i) =>
          `  ${i + 1}. ${o.id} (${o.date}): ${o.items.map(item => `${item.name} x${item.qty}`).join(', ')}`
        ).join('\n') +
        `\n\nREORDER RULE: If the customer asks to reorder or wants "the same as last time", set\n` +
        `reorder_intent to the order ID or "last" for the most recent order.\n` +
        `The server rebuilds the cart at current prices — NEVER state or guess a price.\n`
      : '';

    const systemPrompt =
`You are Zara, an order assistant for ${pharmacyName}.
Your ONLY role is to help customers place product orders. You NEVER give medical advice, dosage guidance, or drug-interaction information. If asked, say exactly: "I can only help with your order. Please speak to a pharmacist for medical questions." — then stop.

PRODUCT CATALOGUE (the ONLY products that exist — never mention or invent any other):
${productList}

CURRENT ORDER STATE:
${JSON.stringify(snap)}
${orderHistorySection}
YOUR JOB:
Read the current state. Ask for ONLY the next missing piece. One question at a time.

PHASE GUIDE:
- "product": product is null → find out what the customer wants (set product_name_mentioned in extracted).
             product is set but qty is null → ask how many.
- "rx_confirm": requires_rx is true and rx_confirmed is null → ask the customer to send their prescription as an image or PDF. Give NO medical context.
- "more_or_checkout": cart has item(s) → ask if they want another item or to type "checkout".
- "delivery": fulfilment is null → ask delivery or pickup.
              fulfilment is DELIVERY but no delivery_area → ask for the delivery area.
- "confirm": the server has shown the order summary → detect yes or no only.

TONE RULES:
- Warm, brief, plain text. No emoji. No markdown bold or italic in the reply field.
- NEVER state, confirm, or calculate a price. The server handles all money display.
- Use the customer name at most TWICE across the whole conversation.
- Never ask for the customer phone number.
- Vary acknowledgement phrases; never repeat the same phrase twice in a row.
- If the customer asks a medical question: give the one redirect sentence above, nothing else.

PAYMENT RULES (CRITICAL — never break these):
- Payment is by manual bank transfer, verified by pharmacy STAFF checking their bank account. You cannot see payments.
- NEVER say or imply that a payment has been received, confirmed, or verified. Never say "payment received", "payment confirmed", or anything equivalent.
- If the customer says they have paid, transferred, or sent money: thank them, say the pharmacy team will verify the transfer shortly and the order will be processed once they confirm it. Do not change anything else about the order.

INTENT VALUES: order | track | cancel | collecting

RESPOND WITH THIS JSON ONLY — no text outside the JSON object:
{
  "reply": "...",
  "extracted": {
    "product_name_mentioned": null,
    "qty": null,
    "fulfilment": null,
    "delivery_area": null,
    "rx_confirmed": null,
    "reorder_intent": null
  },
  "intent": "collecting"
}

Populate extracted fields ONLY when you actually observed them in the customer message.`;

    // Strip timestamps — only role + content sent to AI
    const aiMessages = [
      { role: 'system', content: systemPrompt },
      ...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
    ];

    let rawText = '';
    try {
      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: aiMessages,
        temperature: 0.3,
        max_tokens: 400,
        response_format: { type: 'json_object' },
      });
      rawText = completion.choices[0].message.content;
      // Strip markdown fences before parsing
      rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(rawText);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('Non-object JSON');
      return parsed;
    } catch (e) {
      addLog('error', 'pharmacyAI error', `${e.message} | raw: ${rawText.slice(0, 200)}`);
      return {
        reply: "Could you say that again? I want to make sure I get your order right.",
        extracted: {},
        intent: 'collecting',
      };
    }
  }

  // ── ORDER SUMMARY ─────────────────────────────────────────────────────────
  // All arithmetic in server code — never in the LLM.

  function buildOrderSummary(cart, fulfilment, deliveryArea, pharmacyConfig, currency, delivery) {
    const subtotal = cart.reduce((s, i) => s + i.price_snap * i.qty, 0);
    const fee      = fulfilment === 'DELIVERY'
      ? resolveDeliveryFee(deliveryArea, pharmacyConfig).fee
      : 0;
    const total    = subtotal + fee;

    const lines = cart.map(i =>
      `${i.name_snap} x${i.qty}  ${formatCurrency(i.price_snap * i.qty, currency)}`
    );

    let msg = `Order Summary\n\n${lines.join('\n')}\n\nSubtotal: ${formatCurrency(subtotal, currency)}\n`;
    msg += fulfilment === 'DELIVERY'
      ? `Delivery${deliveryArea ? ' to ' + deliveryArea : ''}: ${formatCurrency(fee, currency)}\n`
      : `Fulfilment: Pickup\n`;
    msg += `Total: ${formatCurrency(total, currency)}\n`;

    // Echo the collected delivery details so the customer verifies name / phone /
    // address before confirming — and can catch a wrong entry (e.g. an area typed
    // into the name field). Reply *edit* re-collects them.
    if (fulfilment === 'DELIVERY' && delivery) {
      const d = delivery;
      const areaLine = [d.area, d.landmark].filter(Boolean).join(' — ');
      const details  = [d.name, d.phone, d.address, areaLine].filter(Boolean);
      if (details.length) msg += `\nDeliver to:\n${details.join('\n')}\n`;
    }

    msg += fulfilment === 'DELIVERY'
      ? `\nReply YES to confirm, *edit* to change delivery details, or NO to cancel.`
      : `\nReply YES to confirm or NO to cancel.`;

    return { msg, subtotal, fee, total };
  }

  // ── ADD ITEM TO CART ──────────────────────────────────────────────────────

  async function addItemToCart(state, history, externalUserId, pharmacyConfig, now) {
    const currency = pharmacyConfig.currency || 'NGN';

    state.cart.push({
      product_id            : state.product_id,
      name_snap             : state.product_name,
      price_snap            : state.product_price,
      qty                   : state.qty,
      requires_prescription : state.product_requires_prescription,
    });

    // Reset pending-item fields
    state.product_id = null;
    state.product_name = null;
    state.product_price = null;
    state.product_requires_prescription = false;
    state.rx_confirmed = null;
    state.prescription_url = state.prescription_url || null; // keep if set
    state.qty = null;
    state.phase = 'more_or_checkout';

    const cartLines = state.cart.map(i =>
      `${i.name_snap} x${i.qty}  ${formatCurrency(i.price_snap * i.qty, currency)}`
    );
    const subtotal = state.cart.reduce((s, i) => s + i.price_snap * i.qty, 0);

    const reply =
      `Added to your cart.\n\nCart:\n${cartLines.join('\n')}\nSubtotal: ${formatCurrency(subtotal, currency)}\n\n` +
      `Would you like to add another item, or type *checkout* to proceed?`;

    history.push({ role: 'assistant', content: reply, timestamp: now });
    await saveConv(externalUserId, pharmacyConfig.id, state, history);
    return reply;
  }

  // ── REORDER ───────────────────────────────────────────────────────────────
  // Rebuilds a prior order's cart at CURRENT prices. Old price_snap values are NEVER reused.
  // reorderIntent: 'last' | order ID string (e.g. 'OCP-123456')

  async function handleReorder(reorderIntent, state, history, externalUserId, pharmacyConfig, adapter, now) {
    const currency     = pharmacyConfig.currency || 'NGN';
    const recentOrders = state.recent_orders || [];

    let targetOrder = null;
    if (reorderIntent === 'last') {
      targetOrder = recentOrders[0] || null;
    } else {
      targetOrder = recentOrders.find(
        o => o.id === reorderIntent || o.id === `OCP-${reorderIntent}`
      ) || null;
    }

    if (!targetOrder || !targetOrder.items?.length) {
      const reply = recentOrders.length === 0
        ? `I don't see any previous orders on file. What product are you looking for?`
        : `I couldn't find that order. Here are your recent orders:\n\n` +
          recentOrders.map(o => `${o.id}: ${o.items.map(i => `${i.name} x${i.qty}`).join(', ')}`).join('\n') +
          `\n\nWhich would you like to reorder?`;
      state.phase = 'product';
      delete state.pending_reorder;
      history.push({ role: 'assistant', content: reply, timestamp: now });
      await saveConv(externalUserId, pharmacyConfig.id, state, history);
      return reply;
    }

    // Fetch current catalogue — never use stored prices from prior order
    const allProducts = await adapter.getProducts();
    const productMap  = new Map(allProducts.map(p => [String(p.id), p]));
    const newCart     = [];
    const skipped     = [];

    for (const item of targetOrder.items) {
      const product = productMap.get(String(item.product_id));
      if (!product) { skipped.push(item.name); continue; }
      const avail = await adapter.checkStock(item.product_id);
      if (avail <= 0) { skipped.push(item.name); continue; }
      newCart.push({
        product_id            : product.id,
        name_snap             : product.name,
        price_snap            : parseFloat(product.price), // CURRENT price — not old price_snap
        qty                   : Math.min(item.qty, avail),
        requires_prescription : product.requires_prescription || false,
      });
    }

    if (newCart.length === 0) {
      const reply =
        `Sorry, the items from order ${targetOrder.id} are not in stock right now.\n\n` +
        `What else are you looking for?`;
      state.phase = 'product';
      state.cart  = [];
      delete state.pending_reorder;
      history.push({ role: 'assistant', content: reply, timestamp: now });
      await saveConv(externalUserId, pharmacyConfig.id, state, history);
      return reply;
    }

    state.cart  = newCart;
    state.phase = 'more_or_checkout';
    delete state.pending_reorder;

    const cartLines = newCart.map(i =>
      `${i.name_snap} x${i.qty}  ${formatCurrency(i.price_snap * i.qty, currency)}`
    );
    const subtotal = newCart.reduce((s, i) => s + i.price_snap * i.qty, 0);

    let reply =
      `Here's your cart rebuilt with today's prices:\n\nCart:\n${cartLines.join('\n')}\n` +
      `Subtotal: ${formatCurrency(subtotal, currency)}`;
    if (skipped.length) {
      reply += `\n\n(${skipped.join(', ')} ${skipped.length === 1 ? 'is' : 'are'} currently out of stock and not included.)`;
    }
    reply += `\n\nWould you like to add anything else, or type *checkout* to proceed?`;

    history.push({ role: 'assistant', content: reply, timestamp: now });
    await saveConv(externalUserId, pharmacyConfig.id, state, history);
    return reply;
  }

  // ── MAIN PROCESSOR ────────────────────────────────────────────────────────

  async function processPharmacyMessage(externalUserId, message, mediaAttachment, pharmacyConfig, adapter, identity = null) {
    const conv = await getConv(externalUserId, pharmacyConfig.id);

    const msg      = (message || '').trim().toLowerCase();
    const now      = new Date().toISOString();
    const currency = pharmacyConfig.currency || 'NGN';

    // node-pg auto-parses JSONB; guard string fallback for safety
    let state   = typeof conv.state   === 'string' ? JSON.parse(conv.state)   : (conv.state   || { machine: 'START' });
    let history = typeof conv.history === 'string' ? JSON.parse(conv.history) : (conv.history || []);

    // ── GLOBAL RESET ──
    if (['restart', 'reset', 'start over'].includes(msg)) {
      await saveConv(externalUserId, pharmacyConfig.id, { machine: 'START' }, []);
      return `Session restarted. Send a message to begin.`;
    }

    // ── START → MENU ──
    if (state.machine === 'START') {
      const daypart   = getDaypart(pharmacyConfig.timezone);
      const firstName = identity?.name?.split(' ')[0] || null;
      const greeting  = firstName ? `${daypart}, ${firstName}.` : `${daypart}.`;

      // Load compact order history for identified users — session context only, no diagnostic fields.
      let recentOrders = [];
      if (identity?.externalUserId) {
        try {
          const raw = await adapter.getCustomerOrders(identity.externalUserId);
          recentOrders = formatRecentOrders(raw);
        } catch (e) {
          addLog('warn', 'getCustomerOrders failed on START', e.message);
        }
      }

      const welcome =
        `${greeting} Welcome${recentOrders.length ? ' back' : ''} to *${pharmacyConfig.pharmacy_name}*.\n\n` +
        `I'm Zara, your pharmacy assistant. How can I help you today?\n\n` +
        `1. Place an order\n2. Book a consultation\n3. Make an enquiry`;

      history = [{ role: 'assistant', content: welcome, timestamp: now }];
      await saveConv(externalUserId, pharmacyConfig.id, {
        machine            : 'MENU',
        recent_orders      : recentOrders,
        customer_first_name: firstName,
      }, history);
      return welcome;
    }

    // ── DONE → return to MENU ──
    if (state.machine === 'DONE') {
      // Customer reporting a bank transfer after checkout: acknowledge,
      // repeat that staff will verify, keep the DONE state. The order status
      // is NEVER changed from chat.
      if (isPaymentClaim(msg)) {
        const reply = buildPaymentClaimReply(state, pharmacyConfig);
        history.push({ role: 'user', content: message || '(media)', timestamp: now });
        history.push({ role: 'assistant', content: reply, timestamp: now });
        await saveConv(externalUserId, pharmacyConfig.id, state, history, 'DONE');
        return reply;
      }

      // Customer is picking a menu option (e.g. tapped "1. Place an order" from
      // the post-order "anything else?" prompt): route straight into that flow
      // instead of replaying the welcome. Switch to MENU and fall through to the
      // MENU handler below, which pushes the message and dispatches it.
      if (isMenuSelection(msg)) {
        state.machine = 'MENU';
        // (no return — fall through)
      } else {
        const firstName = state.customer_first_name || null;
        const daypart   = getDaypart(pharmacyConfig.timezone);
        const greeting  = firstName ? `${daypart}, ${firstName}.` : `${daypart}.`;
        const welcome =
          `${greeting} Welcome back to *${pharmacyConfig.pharmacy_name}*. How can I help?\n\n` +
          `1. Place an order\n2. Book a consultation\n3. Make an enquiry`;
        history = [{ role: 'assistant', content: welcome, timestamp: now }];
        await saveConv(externalUserId, pharmacyConfig.id, {
          machine            : 'MENU',
          recent_orders      : state.recent_orders || [],
          customer_first_name: firstName,
          last_order_id      : state.last_order_id || null, // kept so a later "I've paid" can reference it
        }, history);
        return welcome;
      }
    }

    // ── MENU — detect selection ──
    if (state.machine === 'MENU') {
      history.push({ role: 'user', content: message || '(media)', timestamp: now });

      // Payment claim — checked before keyword routing so "I paid for my
      // order" never starts a new order flow. No status change from chat.
      if (isPaymentClaim(msg)) {
        const reply = buildPaymentClaimReply(state, pharmacyConfig);
        history.push({ role: 'assistant', content: reply, timestamp: now });
        await saveConv(externalUserId, pharmacyConfig.id, state, history);
        return reply;
      }

      let nextPhase = null;
      let intro     = '';

      // Reorder shortcut — checked before the general 'order' keyword
      if (msg.includes('reorder') || msg.includes('same as last') || msg.includes('last order') || msg.includes('order again')) {
        nextPhase = 'product';
        const hasHistory = (state.recent_orders || []).length > 0;
        if (hasHistory) {
          state.pending_reorder = 'last';
          intro = `Let me rebuild your last order with today's prices.`;
        } else {
          intro = `What product are you looking for? Tell me the name and I'll find it.`;
        }
      } else if (msg === '1' || msg.includes('order') || msg.includes('buy') || msg.includes('purchase') || msg.includes('need')) {
        nextPhase = 'product';
        intro = `What product are you looking for? Tell me the name and I'll find it.`;
      } else if (msg === '2' || msg.includes('consult') || msg.includes('appointment') || msg.includes('see a doctor') || msg.includes('book')) {
        nextPhase = 'consult_collect';
      } else if (msg === '3' || msg.includes('enquir') || msg.includes('question') || msg.includes('ask')) {
        nextPhase = 'enquiry_collect';
      }

      if (nextPhase) {
        const activeState = {
          machine            : 'ACTIVE',
          phase              : nextPhase,
          cart               : [],
          pending_reorder    : state.pending_reorder || null,
          recent_orders      : state.recent_orders || [],
          customer_first_name: state.customer_first_name || null,
        };

        // Consultation/enquiry: seed the sequential collector and open with its
        // first question (prefilling name/contact from the verified user).
        if (nextPhase === 'consult_collect') {
          const c = activeState.consult = {};
          if (identity?.name)  c.name  = identity.name;
          if (identity?.phone) c.phone = identity.phone;
          const np = consultNextPrompt(c);
          activeState.consult_awaiting = np ? np.awaiting : null;
          intro = np ? np.prompt : `Let me set up your consultation.`;
        } else if (nextPhase === 'enquiry_collect') {
          const e = activeState.enquiry = {};
          if (identity?.name)                   e.name    = identity.name;
          if (identity?.phone || identity?.email) e.contact = identity.phone || identity.email;
          const np = enquiryNextPrompt(e);
          activeState.enquiry_awaiting = np ? np.awaiting : null;
          intro = np ? np.prompt : `What's your question?`;
        }

        history.push({ role: 'assistant', content: intro, timestamp: now });
        await saveConv(externalUserId, pharmacyConfig.id, activeState, history);
        return intro;
      }

      const clarify = `Sorry, I didn't catch that. Please reply:\n\n1. Place an order\n2. Book a consultation\n3. Make an enquiry`;
      history.push({ role: 'assistant', content: clarify, timestamp: now });
      await saveConv(externalUserId, pharmacyConfig.id, state, history);
      return clarify;
    }

    // ── ACTIVE ────────────────────────────────────────────────────────────────
    if (state.machine === 'ACTIVE') {
      // Don't duplicate the user message if MENU already pushed it (MENU → ACTIVE transition)
      const lastH = history[history.length - 1];
      const incomingContent = message || '(media)';
      if (!lastH || lastH.role !== 'user' || lastH.content !== incomingContent) {
        history.push({ role: 'user', content: incomingContent, timestamp: now });
      }

      const phase = state.phase;

      // ── STRAY PRESCRIPTION ATTACHMENT ─────────────────────────────────────
      // A prescription file can arrive outside the rx_confirm step — the
      // customer attaches it early, or onto a cart that already holds its Rx
      // item. rx_confirm has its own upload handler below; everywhere in the
      // order flow we still capture the file (and log the outcome) so it
      // attaches to the order instead of being silently dropped. Consultation
      // and enquiry phases are left alone — they aren't order/Rx steps.
      if (mediaAttachment && (mediaAttachment.buffer || mediaAttachment.mediaId) &&
          phase !== 'rx_confirm' && phase !== 'consult_collect' && phase !== 'enquiry_collect') {
        try {
          const buffer = mediaAttachment.buffer || await downloadMedia(mediaAttachment.mediaId);
          const { url } = await adapter.savePrescription({
            buffer,
            mimetype : mediaAttachment.mediaMime    || 'application/octet-stream',
            filename : mediaAttachment.mediaFilename || `rx_${Date.now()}.bin`,
          });
          state.prescription_url = url;
          addLog('info', `Prescription received (phase=${phase || 'none'}) for ${externalUserId}: ${url}`);
          const ack = (state.cart && state.cart.length)
            ? `Thanks, I've received your prescription and attached it to your order. Type *checkout* when you're ready, or tell me what else you need.`
            : `Thanks, I've received your prescription. What would you like to order?`;
          history.push({ role: 'assistant', content: ack, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return ack;
        } catch (e) {
          console.error('[pharmacyFlow.savePrescription:stray]', e.message, e.details || '', e.hint || '', e.code || '');
          addLog('error', 'Prescription upload failed (stray)',
            [e.message, e.details, e.hint, e.code].filter(Boolean).join(' | '));
          const errMsg = `There was a problem receiving your prescription. Please try sending it again as an image or PDF.`;
          history.push({ role: 'assistant', content: errMsg, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return errMsg;
        }
      }

      // Auto-execute reorder if MENU detected reorder intent before AI was involved
      if (state.pending_reorder) {
        return await handleReorder(state.pending_reorder, state, history, externalUserId, pharmacyConfig, adapter, now);
      }

      // ════════════════════════════════════════════════════
      // CONSULTATION FLOW — collect enough for a pharmacist to action.
      // Zara gives NO medical advice; she captures details and routes to staff.
      // ════════════════════════════════════════════════════
      if (phase === 'consult_collect') {
        const c   = state.consult || (state.consult = {});
        const ans = (message || '').trim();
        const awaiting = state.consult_awaiting;

        if      (awaiting === 'name'  && ans.length >= 2)                  c.name  = ans;
        else if (awaiting === 'phone' && ans.replace(/\D/g, '').length >= 5) c.phone = ans;
        else if (awaiting === 'about' && ans.length >= 3)                  c.about = ans;
        else if (awaiting === 'time'  && ans.length >= 2)                  c.time  = ans;
        else if (awaiting === 'meds') {
          const a = ans.toLowerCase();
          if (/^(no|n|none)\b/.test(a) || a === 'no') { c.on_meds = false; c.meds_detail = null; }
          else { c.on_meds = true; c.meds_detail = ans.replace(/^y(es)?[\s,:.-]*/i, '').trim() || ans; }
        }

        const np = consultNextPrompt(c);
        if (np) {
          state.consult_awaiting = np.awaiting;
          history.push({ role: 'assistant', content: np.prompt, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return np.prompt;
        }

        // Complete → record/flag for staff and confirm the details back.
        state.consult_awaiting = null;
        const medsLine = c.on_meds ? (c.meds_detail || 'yes') : 'none';
        const summary =
          `- Name: ${c.name}\n- Contact: ${c.phone}\n- About: ${c.about}\n` +
          `- Availability: ${c.time}\n- Current medication: ${medsLine}`;
        if (pharmacyConfig.handoff_number) {
          await sendWhatsApp(
            pharmacyConfig.handoff_number,
            `*Consultation Request*\n\n${summary}\n\nFrom: ${externalUserId}`,
            pharmacyConfig.phone_number_id
          );
        }
        io.emit('queue_updated', { type: 'pharmacy_consultation', pharmacyId: pharmacyConfig.id, from: externalUserId });

        const done =
          `Thank you, ${c.name.split(' ')[0]}. Here's what I've passed to our pharmacist:\n\n${summary}\n\n` +
          `They'll be in touch to arrange your consultation.\n\n` +
          `Is there anything else I can help you with?\n\n1. Place an order\n2. Book a consultation\n3. Make an enquiry`;
        history.push({ role: 'assistant', content: done, timestamp: now });
        await saveConv(externalUserId, pharmacyConfig.id, { machine: 'DONE', recent_orders: state.recent_orders || [], customer_first_name: state.customer_first_name || c.name.split(' ')[0] || null }, history, 'DONE');
        return done;
      }

      // ════════════════════════════════════════════════════
      // ENQUIRY FLOW — capture the question plus a name + contact so staff can
      // follow up. (Auto-answering simple questions from product data is not yet
      // implemented — every enquiry is routed to a human.)
      // ════════════════════════════════════════════════════
      if (phase === 'enquiry_collect') {
        const e   = state.enquiry || (state.enquiry = {});
        const ans = (message || '').trim();
        const awaiting = state.enquiry_awaiting;

        if      (awaiting === 'question' && ans.length >= 3) e.question = ans;
        else if (awaiting === 'name'     && ans.length >= 2) e.name     = ans;
        else if (awaiting === 'contact'  && ans.length >= 3) e.contact  = ans;

        const np = enquiryNextPrompt(e);
        if (np) {
          state.enquiry_awaiting = np.awaiting;
          history.push({ role: 'assistant', content: np.prompt, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return np.prompt;
        }

        state.enquiry_awaiting = null;
        const summary = `Question: ${e.question}\nName: ${e.name}\nContact: ${e.contact}`;
        if (pharmacyConfig.handoff_number) {
          await sendWhatsApp(
            pharmacyConfig.handoff_number,
            `*Pharmacy Enquiry*\n\n${summary}\n\nFrom: ${externalUserId}`,
            pharmacyConfig.phone_number_id
          );
        }
        io.emit('queue_updated', { type: 'pharmacy_enquiry', pharmacyId: pharmacyConfig.id });

        const done =
          `Thanks, ${e.name.split(' ')[0]}. Your question has been passed to our team and we'll get back to you via ${e.contact} shortly.\n\n` +
          `Is there anything else I can help you with?\n\n1. Place an order\n2. Book a consultation\n3. Make an enquiry`;
        history.push({ role: 'assistant', content: done, timestamp: now });
        await saveConv(externalUserId, pharmacyConfig.id, { machine: 'DONE', recent_orders: state.recent_orders || [], customer_first_name: state.customer_first_name || e.name.split(' ')[0] || null }, history, 'DONE');
        return done;
      }

      // ════════════════════════════════════════════════════
      // ORDER FLOW
      // ════════════════════════════════════════════════════

      // ── PHASE: CONFIRM ──────────────────────────────────
      if (phase === 'confirm') {
        // Let the customer correct delivery details before confirming (e.g. a
        // wrong name). Re-collects from the start, keeping verified identity.
        if (msg === 'edit' && state.fulfilment === 'DELIVERY') {
          state.phase    = 'delivery_details';
          const d = state.delivery = {};
          if (identity?.name)  d.name  = identity.name;
          if (identity?.phone) d.phone = identity.phone;
          const np = deliveryNextPrompt(d, pharmacyConfig);
          state.delivery_awaiting = np ? np.awaiting : null;
          const reply = `No problem — let's update your delivery details. ${np ? np.prompt : ''}`.trim();
          history.push({ role: 'assistant', content: reply, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return reply;
        }

        if (['yes', 'y', 'confirm', 'ok', 'sure', 'yep', 'yeah'].includes(msg)) {
          // Never complete a delivery order without an address and area — bounce
          // back into detail collection rather than writing an unfulfillable order.
          const del = state.delivery || {};
          if (state.fulfilment === 'DELIVERY' && (!del.address || !del.area)) {
            state.phase = 'delivery_details';
            const np = deliveryNextPrompt(del, pharmacyConfig);
            state.delivery_awaiting = np ? np.awaiting : null;
            const reply = `Before I place the order I still need your delivery details. ${np ? np.prompt : ''}`.trim();
            history.push({ role: 'assistant', content: reply, timestamp: now });
            await saveConv(externalUserId, pharmacyConfig.id, state, history);
            return reply;
          }

          const { subtotal, fee, total } = buildOrderSummary(
            state.cart, state.fulfilment, state.delivery_area, pharmacyConfig, currency
          );

          const orderObj = {
            customer_id      : externalUserId,
            customer_phone   : del.phone || identity?.phone || externalUserId,
            customer_name    : del.name  || identity?.name  || state.customer_name || state.customer_first_name || null,
            customer_email   : identity?.email || null,
            items            : state.cart.map(i => ({
              product_id : i.product_id,
              name_snap  : i.name_snap,
              price_snap : i.price_snap,
              qty        : i.qty,
            })),
            subtotal,
            delivery_fee      : fee,
            total,
            fulfilment        : state.fulfilment,
            delivery_area     : del.area    || state.delivery_area || null,
            delivery_address  : del.address || null,
            delivery_city     : del.area    || null,
            delivery_landmark : del.landmark || null,
            prescription_url  : state.prescription_url || null,
          };

          let orderId;
          try {
            ({ orderId } = await adapter.createOrder(orderObj));
          } catch (e) {
            // Log the FULL Supabase error (details/hint/code attached by the
            // adapter) — the user-facing reply stays generic.
            console.error('[pharmacyFlow.createOrder]', e.message, e.details || '', e.hint || '', e.code || '');
            addLog('error', 'adapter.createOrder failed',
              [e.message, e.details, e.hint, e.code].filter(Boolean).join(' | '));
            const errReply = `There was a problem placing your order. Please try again or contact us directly.`;
            history.push({ role: 'assistant', content: errReply, timestamp: now });
            await saveConv(externalUserId, pharmacyConfig.id, state, history);
            return errReply;
          }

          // Decrement stock at ORDER CREATION (v1 decision) — non-blocking; a
          // failure here does not cancel the order. Orders are created
          // 'pending' and only flip to 'paid' when staff confirm the bank
          // transfer, so a never-paid order holds stock until staff cancel it.
          // Moving this decrement to payment confirmation (markOrderPaid) is a
          // v1.5 decision — do NOT change the timing as part of other fixes.
          adapter.decrementStock(state.cart.map(i => ({ product_id: i.product_id, qty: i.qty })))
            .catch(e => {
              console.error('[pharmacyFlow.decrementStock]', e.message, e.details || '', e.hint || '', e.code || '');
              addLog('error', 'adapter.decrementStock failed',
                [e.message, e.details, e.hint, e.code].filter(Boolean).join(' | '));
            });

          const needsRx = state.cart.some(i => i.requires_prescription);

          // PAYMENT LANGUAGE RULE (critical): the order is AWAITING PAYMENT
          // until staff verify the bank transfer and mark it paid. This
          // message must never say payment was "received" or "confirmed" —
          // order.status is still 'pending' at this point.
          const payInstr = buildPaymentInstructions(pharmacyConfig, orderId, total, currency);

          let confirmMsg =
            `Your order is confirmed and is now awaiting payment.\n\n` +
            `Order ID: *${orderId}*\nTotal: ${formatCurrency(total, currency)}\n\n`;
          if (needsRx) {
            confirmMsg +=
              `One or more items require a valid prescription. Our pharmacist will review it before processing.\n\n`;
          }
          confirmMsg += payInstr
            ? `${payInstr}\n\n` +
              `Once you've made the transfer, the pharmacy will verify it shortly and start processing your order.\n\n` +
              `Thank you for ordering from ${pharmacyConfig.pharmacy_name}.`
            : `Our team will be in touch with payment details shortly.\n\n` +
              `Thank you for ordering from ${pharmacyConfig.pharmacy_name}.`;

          // Loop back to the opening menu so the conversation doesn't dead-end
          // after checkout. State goes to DONE; a reply of 1/2/3 routes straight
          // back into a flow (see the DONE → MENU fall-through above).
          confirmMsg +=
            `\n\nIs there anything else I can help you with?\n\n` +
            `1. Place an order\n2. Book a consultation\n3. Make an enquiry`;

          history.push({ role: 'assistant', content: confirmMsg, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, {
            machine            : 'DONE',
            recent_orders      : state.recent_orders || [],
            customer_first_name: state.customer_first_name || null,
            last_order_id      : orderId, // referenced if the customer later says "I've paid"
            last_order_total   : total,
          }, history, 'DONE');
          io.emit('queue_updated', { type: 'pharmacy_order', orderId, pharmacyId: pharmacyConfig.id, needsRx });
          addLog('info', `Order ${orderId} | ${pharmacyConfig.pharmacy_name} | ${formatCurrency(total, currency)}`);
          return confirmMsg;
        }

        if (['no', 'n', 'cancel'].includes(msg)) {
          state.phase = 'more_or_checkout';
          const reply =
            `Order cancelled. Your cart still has ${state.cart.length} item(s). ` +
            `Type *checkout* to try again or *clear* to empty your cart.`;
          history.push({ role: 'assistant', content: reply, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return reply;
        }

        // Unrecognised input while in confirm — re-show the summary
        const { msg: summaryMsg } = buildOrderSummary(
          state.cart, state.fulfilment, state.delivery_area, pharmacyConfig, currency, state.delivery
        );
        history.push({ role: 'assistant', content: summaryMsg, timestamp: now });
        await saveConv(externalUserId, pharmacyConfig.id, state, history);
        return summaryMsg;
      }

      // ── PHASE: DELIVERY (choose fulfilment) ─────────────
      if (phase === 'delivery') {
        let resolved = null;
        if (msg === '1' || msg.includes('deliver')) resolved = 'DELIVERY';
        else if (msg === '2' || msg.includes('pickup') || msg.includes('pick up') || msg.includes('collect')) resolved = 'PICKUP';

        if (resolved === 'PICKUP') {
          state.fulfilment = 'PICKUP';
          state.phase = 'confirm';
          const { msg: summaryMsg } = buildOrderSummary(state.cart, 'PICKUP', null, pharmacyConfig, currency);
          history.push({ role: 'assistant', content: summaryMsg, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return summaryMsg;
        }

        if (resolved === 'DELIVERY') {
          state.fulfilment = 'DELIVERY';
          state.phase = 'delivery_details';
          // Reuse any details already collected (e.g. after a cancelled confirm);
          // prefill name/phone from the verified Supabase user when logged in.
          const d = state.delivery || (state.delivery = {});
          if (!d.name  && identity?.name)  d.name  = identity.name;
          if (!d.phone && identity?.phone) d.phone = identity.phone;
          const np = deliveryNextPrompt(d, pharmacyConfig);
          state.delivery_awaiting = np ? np.awaiting : null;
          const ask = np ? np.prompt : `Where should we deliver to?`;
          history.push({ role: 'assistant', content: ask, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return ask;
        }

        const fallback = `How would you like to receive your order?\n\n1. Delivery\n2. Pickup`;
        history.push({ role: 'assistant', content: fallback, timestamp: now });
        await saveConv(externalUserId, pharmacyConfig.id, state, history);
        return fallback;
      }

      // ── PHASE: DELIVERY_DETAILS (collect name/phone/address/area/landmark) ──
      if (phase === 'delivery_details') {
        const d   = state.delivery || (state.delivery = {});
        const ans = (message || '').trim();
        const awaiting = state.delivery_awaiting;

        // Record the answer to whatever field we last asked for. A blank/invalid
        // answer leaves the field unset, so deliveryNextPrompt re-asks it.
        if      (awaiting === 'name'    && ans.length >= 2)                 d.name    = ans;
        else if (awaiting === 'phone'   && ans.replace(/\D/g, '').length >= 7) d.phone = ans;
        else if (awaiting === 'address' && ans.length >= 6)                 d.address = ans;
        else if (awaiting === 'area'    && ans.length >= 2)                 d.area    = ans;
        else if (awaiting === 'landmark') {
          d.landmark = /^(skip|no|none|n)$/i.test(ans) ? null : (ans || null);
          d.landmark_asked = true;
        }

        const np = deliveryNextPrompt(d, pharmacyConfig);
        if (np) {
          state.delivery_awaiting = np.awaiting;
          history.push({ role: 'assistant', content: np.prompt, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return np.prompt;
        }

        // All details collected → resolve the zone fee and show the summary.
        state.delivery_area     = d.area;
        state.delivery_awaiting = null;
        state.phase             = 'confirm';
        const zone = resolveDeliveryFee(d.area, pharmacyConfig);
        const { msg: summaryMsg } = buildOrderSummary(state.cart, 'DELIVERY', d.area, pharmacyConfig, currency, d);
        const lead = zone.matched
          ? `Got it — delivering to ${d.area}.`
          : `Got it. We'll deliver to ${d.area}.`;
        const reply = `${lead}\n\n${summaryMsg}`;
        history.push({ role: 'assistant', content: reply, timestamp: now });
        await saveConv(externalUserId, pharmacyConfig.id, state, history);
        return reply;
      }

      // ── PHASE: MORE_OR_CHECKOUT ──────────────────────────
      if (phase === 'more_or_checkout') {
        if (msg === 'clear' || msg === 'clear cart') {
          state.cart = [];
          state.phase = 'product';
          const reply = `Cart cleared. What product are you looking for?`;
          history.push({ role: 'assistant', content: reply, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return reply;
        }

        if (['checkout', 'done', 'proceed', "that's all", "thats all", "that's it", 'no more', 'nothing else', 'pay'].includes(msg)) {
          state.phase = 'delivery';
          state.fulfilment = null;
          state.delivery_area = null;
          const delivQ = `How would you like to receive your order?\n\n1. Delivery\n2. Pickup`;
          history.push({ role: 'assistant', content: delivQ, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return delivQ;
        }
      }

      // ── PHASE: RX_CONFIRM ────────────────────────────────
      if (phase === 'rx_confirm') {
        // Media attachment = prescription upload.
        // Web channel passes { buffer } directly; WhatsApp passes { mediaId } for download.
        if (mediaAttachment && (mediaAttachment.mediaId || mediaAttachment.buffer)) {
          try {
            const buffer = mediaAttachment.buffer || await downloadMedia(mediaAttachment.mediaId);
            const { url } = await adapter.savePrescription({
              buffer,
              mimetype : mediaAttachment.mediaMime   || 'application/octet-stream',
              filename : mediaAttachment.mediaFilename || `rx_${Date.now()}.bin`,
            });
            state.prescription_url = url;
            state.rx_confirmed = true;
            addLog('info', `Prescription uploaded for ${externalUserId}: ${url}`);
          } catch (e) {
            console.error('[pharmacyFlow.savePrescription]', e.message, e.details || '', e.hint || '', e.code || '');
            addLog('error', 'Prescription upload failed',
              [e.message, e.details, e.hint, e.code].filter(Boolean).join(' | '));
            const errMsg = `There was a problem receiving your prescription. Please try sending it again as an image or PDF.`;
            history.push({ role: 'assistant', content: errMsg, timestamp: now });
            await saveConv(externalUserId, pharmacyConfig.id, state, history);
            return errMsg;
          }
          return await addItemToCart(state, history, externalUserId, pharmacyConfig, now);
        }

        // Text responses in rx_confirm
        const hasRx = ['yes', 'y', 'i have', 'i do', 'have it', 'sent it'].includes(msg) ||
          msg.includes('have a prescription') || msg.includes('have the prescription');
        const noRx  = ['no', 'n'].includes(msg) ||
          msg.includes("don't have") || msg.includes("dont have") || msg.includes("i don't");

        if (hasRx) {
          // Customer claims they have it but didn't send the file yet
          const ask = `Please send your prescription as an image or PDF so we can verify it before processing.`;
          history.push({ role: 'assistant', content: ask, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return ask;
        }

        if (noRx) {
          state.product_id = null; state.product_name = null; state.product_price = null;
          state.product_requires_prescription = false; state.qty = null; state.rx_confirmed = null;
          state.phase = state.cart.length > 0 ? 'more_or_checkout' : 'product';
          const reply = state.cart.length > 0
            ? `No problem. Your cart has ${state.cart.length} item(s). Type *checkout* to proceed or tell me what else you need.`
            : `No problem. What product are you looking for?`;
          history.push({ role: 'assistant', content: reply, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return reply;
        }

        const remind = `${state.product_name} requires a prescription. Please send it as an image or PDF to continue, or reply *no* to remove it from your order.`;
        history.push({ role: 'assistant', content: remind, timestamp: now });
        await saveConv(externalUserId, pharmacyConfig.id, state, history);
        return remind;
      }

      // ── SERVER-SIDE QTY SHORTCUT (digit input while product selected) ──────
      if (phase === 'product' && state.product_id && !state.qty) {
        const n = parseInt(msg);
        if (!isNaN(n) && n >= 1 && n <= 99) {
          const avail = await adapter.checkStock(state.product_id);
          if (n > avail) {
            const reply = `We only have ${avail} unit(s) of ${state.product_name} available. How many would you like?`;
            history.push({ role: 'assistant', content: reply, timestamp: now });
            await saveConv(externalUserId, pharmacyConfig.id, state, history);
            return reply;
          }
          state.qty = n;
          if (state.product_requires_prescription) {
            state.phase = 'rx_confirm';
            const rxQ = `${state.product_name} requires a valid prescription.\n\nPlease send it as an image or PDF to continue.`;
            history.push({ role: 'assistant', content: rxQ, timestamp: now });
            await saveConv(externalUserId, pharmacyConfig.id, state, history);
            return rxQ;
          }
          return await addItemToCart(state, history, externalUserId, pharmacyConfig, now);
        }
      }

      // ── AI CALL ───────────────────────────────────────────────────────────
      const allProducts = await adapter.getProducts();
      const aiResp = await pharmacyAI(message || '', history.slice(-20), state, allProducts, pharmacyConfig.pharmacy_name, state.recent_orders || []);

      // ── REORDER INTENT FROM AI ────────────────────────────────────────────
      if (aiResp.extracted?.reorder_intent) {
        return await handleReorder(aiResp.extracted.reorder_intent, state, history, externalUserId, pharmacyConfig, adapter, now);
      }

      // ── PRODUCT NAME EXTRACTION → server fuzzy match ──────────────────────
      if (aiResp.extracted?.product_name_mentioned && !state.product_id) {
        const inStock = allProducts.filter(p => p.stock_qty > 0);
        const matched = fuzzyMatch(aiResp.extracted.product_name_mentioned, inStock);

        if (matched.length === 0) {
          const alts = allProducts.filter(p => p.stock_qty > 0).slice(0, 5);
          const reply = alts.length === 0
            ? `Sorry, we don't have "${aiResp.extracted.product_name_mentioned}" or any alternatives in stock right now. Please check back soon.`
            : `Sorry, we don't have "${aiResp.extracted.product_name_mentioned}" in stock.\n\nCurrently available:\n` +
              alts.map(p => `${p.name} — ${formatCurrency(p.price, currency)}`).join('\n') +
              `\n\nWould you like any of these?`;
          history.push({ role: 'assistant', content: reply, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return reply;
        }

        const best = matched[0];
        // Price comes from DB — never from the LLM
        state.product_id = best.id;
        state.product_name = best.name;
        state.product_price = parseFloat(best.price);
        state.product_requires_prescription = best.requires_prescription || false;
        state.phase = 'product';

        const confirmReply = `We have *${best.name}* — ${formatCurrency(best.price, currency)} each.\n\nHow many would you like?`;
        history.push({ role: 'assistant', content: confirmReply, timestamp: now });
        await saveConv(externalUserId, pharmacyConfig.id, state, history);
        return confirmReply;
      }

      // ── QTY EXTRACTION FROM AI ────────────────────────────────────────────
      if (aiResp.extracted?.qty && state.product_id && !state.qty) {
        const n = parseInt(aiResp.extracted.qty);
        if (!isNaN(n) && n >= 1 && n <= 99) {
          const avail = await adapter.checkStock(state.product_id);
          if (n > avail) {
            const reply = `We only have ${avail} unit(s) of ${state.product_name}. How many would you like?`;
            history.push({ role: 'assistant', content: reply, timestamp: now });
            await saveConv(externalUserId, pharmacyConfig.id, state, history);
            return reply;
          }
          state.qty = n;
          if (state.product_requires_prescription) {
            state.phase = 'rx_confirm';
            const rxQ = `${state.product_name} requires a valid prescription.\n\nPlease send it as an image or PDF to continue.`;
            history.push({ role: 'assistant', content: rxQ, timestamp: now });
            await saveConv(externalUserId, pharmacyConfig.id, state, history);
            return rxQ;
          }
          return await addItemToCart(state, history, externalUserId, pharmacyConfig, now);
        }
      }

      // ── NEW PRODUCT NAMED WHILE IN more_or_checkout ───────────────────────
      if (aiResp.extracted?.product_name_mentioned && phase === 'more_or_checkout') {
        state.phase = 'product';
        state.product_id = null; state.product_name = null; state.product_price = null;
        state.product_requires_prescription = false; state.rx_confirmed = null; state.qty = null;
        const inStock = allProducts.filter(p => p.stock_qty > 0);
        const matched = fuzzyMatch(aiResp.extracted.product_name_mentioned, inStock);
        if (matched.length > 0) {
          const best = matched[0];
          state.product_id = best.id;
          state.product_name = best.name;
          state.product_price = parseFloat(best.price);
          state.product_requires_prescription = best.requires_prescription || false;
          const confirmReply = `We have *${best.name}* — ${formatCurrency(best.price, currency)} each.\n\nHow many would you like?`;
          history.push({ role: 'assistant', content: confirmReply, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return confirmReply;
        }
      }

      // ── FALLBACK ──────────────────────────────────────────────────────────
      const fallback = aiResp.reply || `What product are you looking for? Tell me the name and I'll find it.`;
      history.push({ role: 'assistant', content: fallback, timestamp: now });
      await saveConv(externalUserId, pharmacyConfig.id, state, history);
      return fallback;
    }

    // Catch-all for unexpected machine state
    return `Welcome to ${pharmacyConfig.pharmacy_name}. Send a message to get started.`;
  }

  // ── CONV STATE READER ─────────────────────────────────────────────────────
  // Called by the web endpoint after processPharmacyMessage to derive widget
  // action hints without re-running the flow.

  async function getConvState(externalUserId, pharmacyId) {
    const res = await pool.query(
      'SELECT state FROM pharmacy_conversations WHERE external_user_id = $1 AND pharmacy_id = $2',
      [externalUserId, pharmacyId]
    );
    if (!res.rows.length) return null;
    const raw = res.rows[0].state;
    return typeof raw === 'string' ? JSON.parse(raw) : (raw || null);
  }

  return { processPharmacyMessage, getConvState };
}

module.exports = { createPharmacyProcessor };
