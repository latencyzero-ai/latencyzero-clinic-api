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

  async function pharmacyAI(message, history, stateData, products, pharmacyName) {
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

    const systemPrompt =
`You are Zara, an order assistant for ${pharmacyName}.
Your ONLY role is to help customers place product orders. You NEVER give medical advice, dosage guidance, or drug-interaction information. If asked, say exactly: "I can only help with your order. Please speak to a pharmacist for medical questions." — then stop.

PRODUCT CATALOGUE (the ONLY products that exist — never mention or invent any other):
${productList}

CURRENT ORDER STATE:
${JSON.stringify(snap)}

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

INTENT VALUES: order | track | cancel | collecting

RESPOND WITH THIS JSON ONLY — no text outside the JSON object:
{
  "reply": "...",
  "extracted": {
    "product_name_mentioned": null,
    "qty": null,
    "fulfilment": null,
    "delivery_area": null,
    "rx_confirmed": null
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

  function buildOrderSummary(cart, fulfilment, deliveryArea, deliveryFeeConfig, currency) {
    const subtotal = cart.reduce((s, i) => s + i.price_snap * i.qty, 0);
    const fee      = fulfilment === 'DELIVERY' ? (parseFloat(deliveryFeeConfig) || 0) : 0;
    const total    = subtotal + fee;

    const lines = cart.map(i =>
      `${i.name_snap} x${i.qty}  ${formatCurrency(i.price_snap * i.qty, currency)}`
    );

    let msg = `Order Summary\n\n${lines.join('\n')}\n\nSubtotal: ${formatCurrency(subtotal, currency)}\n`;
    msg += fulfilment === 'DELIVERY'
      ? `Delivery${deliveryArea ? ' to ' + deliveryArea : ''}: ${formatCurrency(fee, currency)}\n`
      : `Fulfilment: Pickup\n`;
    msg += `Total: ${formatCurrency(total, currency)}\n\nReply YES to confirm or NO to cancel.`;

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

  // ── MAIN PROCESSOR ────────────────────────────────────────────────────────

  async function processPharmacyMessage(externalUserId, message, mediaAttachment, pharmacyConfig, adapter) {
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
      const greeting = getGreeting();
      const welcome =
        `${greeting}. Welcome to *${pharmacyConfig.pharmacy_name}*.\n\n` +
        `I'm Zara, your pharmacy assistant. How can I help you today?\n\n` +
        `1. Place an order\n2. Book a consultation\n3. Make an enquiry`;
      history = [{ role: 'assistant', content: welcome, timestamp: now }];
      await saveConv(externalUserId, pharmacyConfig.id, { machine: 'MENU' }, history);
      return welcome;
    }

    // ── DONE → return to MENU ──
    if (state.machine === 'DONE') {
      const welcome =
        `Welcome back to *${pharmacyConfig.pharmacy_name}*. How can I help?\n\n` +
        `1. Place an order\n2. Book a consultation\n3. Make an enquiry`;
      history = [{ role: 'assistant', content: welcome, timestamp: now }];
      await saveConv(externalUserId, pharmacyConfig.id, { machine: 'MENU' }, history);
      return welcome;
    }

    // ── MENU — detect selection ──
    if (state.machine === 'MENU') {
      history.push({ role: 'user', content: message || '(media)', timestamp: now });

      let nextPhase = null;
      let intro     = '';

      if (msg === '1' || msg.includes('order') || msg.includes('buy') || msg.includes('purchase') || msg.includes('need')) {
        nextPhase = 'product';
        intro = `What product are you looking for? Tell me the name and I'll find it.`;
      } else if (msg === '2' || msg.includes('consult') || msg.includes('appointment') || msg.includes('see a doctor') || msg.includes('book')) {
        nextPhase = 'consult_collect';
        intro = `I'll pass your details to our pharmacist. Please briefly describe what you need help with.`;
      } else if (msg === '3' || msg.includes('enquir') || msg.includes('question') || msg.includes('ask')) {
        nextPhase = 'enquiry_collect';
        intro = `Sure. Type your question and I'll make sure it reaches the right person.`;
      }

      if (nextPhase) {
        history.push({ role: 'assistant', content: intro, timestamp: now });
        await saveConv(externalUserId, pharmacyConfig.id, { machine: 'ACTIVE', phase: nextPhase, cart: [] }, history);
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

      // ════════════════════════════════════════════════════
      // CONSULTATION FLOW
      // ════════════════════════════════════════════════════
      if (phase === 'consult_collect') {
        if (!message || message.trim().length < 5) {
          const ask = `Please describe what you need help with so we can prepare for your consultation.`;
          history.push({ role: 'assistant', content: ask, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return ask;
        }

        const details = message.trim();
        if (pharmacyConfig.handoff_number) {
          await sendWhatsApp(
            pharmacyConfig.handoff_number,
            `*Consultation Request*\n\nFrom: ${externalUserId}\nDetails: ${details}`,
            pharmacyConfig.phone_number_id
          );
        }
        io.emit('queue_updated', { type: 'pharmacy_consultation', pharmacyId: pharmacyConfig.id, from: externalUserId });

        const done =
          `Thank you. Your request has been passed to our pharmacist and someone will be in touch with you shortly.\n\n` +
          `Anything else I can help with?\n\n1. Place an order\n2. Book a consultation\n3. Make an enquiry`;
        history.push({ role: 'assistant', content: done, timestamp: now });
        await saveConv(externalUserId, pharmacyConfig.id, { machine: 'DONE' }, history, 'DONE');
        return done;
      }

      // ════════════════════════════════════════════════════
      // ENQUIRY FLOW
      // ════════════════════════════════════════════════════
      if (phase === 'enquiry_collect') {
        if (!message || message.trim().length < 3) {
          const ask = `Please type your question so I can pass it on.`;
          history.push({ role: 'assistant', content: ask, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return ask;
        }

        const question = message.trim();
        if (pharmacyConfig.handoff_number) {
          await sendWhatsApp(
            pharmacyConfig.handoff_number,
            `*Pharmacy Enquiry*\n\nFrom: ${externalUserId}\nQuestion: ${question}`,
            pharmacyConfig.phone_number_id
          );
        }
        io.emit('queue_updated', { type: 'pharmacy_enquiry', pharmacyId: pharmacyConfig.id });

        const done =
          `Your question has been passed on. We will get back to you shortly.\n\n` +
          `Anything else?\n\n1. Place an order\n2. Book a consultation\n3. Make an enquiry`;
        history.push({ role: 'assistant', content: done, timestamp: now });
        await saveConv(externalUserId, pharmacyConfig.id, { machine: 'DONE' }, history, 'DONE');
        return done;
      }

      // ════════════════════════════════════════════════════
      // ORDER FLOW
      // ════════════════════════════════════════════════════

      // ── PHASE: CONFIRM ──────────────────────────────────
      if (phase === 'confirm') {
        if (['yes', 'y', 'confirm', 'ok', 'sure', 'yep', 'yeah'].includes(msg)) {
          const deliveryFeeConfig = pharmacyConfig.delivery_fee;
          const { subtotal, fee, total } = buildOrderSummary(
            state.cart, state.fulfilment, state.delivery_area, deliveryFeeConfig, currency
          );

          const orderObj = {
            customer_id      : externalUserId,
            customer_phone   : externalUserId,
            customer_name    : state.customer_name    || null,
            items            : state.cart.map(i => ({
              product_id : i.product_id,
              name_snap  : i.name_snap,
              price_snap : i.price_snap,
              qty        : i.qty,
            })),
            subtotal,
            delivery_fee     : fee,
            total,
            fulfilment       : state.fulfilment,
            delivery_area    : state.delivery_area    || null,
            prescription_url : state.prescription_url || null,
          };

          let orderId;
          try {
            ({ orderId } = await adapter.createOrder(orderObj));
          } catch (e) {
            addLog('error', 'adapter.createOrder failed', e.message);
            const errReply = `There was a problem placing your order. Please try again or contact us directly.`;
            history.push({ role: 'assistant', content: errReply, timestamp: now });
            await saveConv(externalUserId, pharmacyConfig.id, state, history);
            return errReply;
          }

          // Decrement stock — non-blocking; a failure here does not cancel the order
          adapter.decrementStock(state.cart.map(i => ({ product_id: i.product_id, qty: i.qty })))
            .catch(e => addLog('error', 'adapter.decrementStock failed', e.message));

          const needsRx = state.cart.some(i => i.requires_prescription);
          let confirmMsg;

          if (needsRx) {
            confirmMsg =
              `Your order has been placed.\n\nReference: *${orderId}*\nTotal: ${formatCurrency(total, currency)}\n\n` +
              `One or more items require a valid prescription. Our pharmacist will review before processing.\n\n` +
              `Thank you for ordering from ${pharmacyConfig.pharmacy_name}.`;
          } else if (pharmacyConfig.manual_payment_details) {
            confirmMsg =
              `Your order is confirmed.\n\nReference: *${orderId}*\nTotal: ${formatCurrency(total, currency)}\n\n` +
              `Please make payment via:\n${pharmacyConfig.manual_payment_details}\n\n` +
              `Use *${orderId}* as your payment reference.\n\n` +
              `Thank you for ordering from ${pharmacyConfig.pharmacy_name}.`;
          } else {
            confirmMsg =
              `Your order is confirmed.\n\nReference: *${orderId}*\nTotal: ${formatCurrency(total, currency)}\n\n` +
              `Our team will be in touch with payment details shortly.\n\n` +
              `Thank you for ordering from ${pharmacyConfig.pharmacy_name}.`;
          }

          history.push({ role: 'assistant', content: confirmMsg, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, { machine: 'DONE' }, history, 'DONE');
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
          state.cart, state.fulfilment, state.delivery_area, pharmacyConfig.delivery_fee, currency
        );
        history.push({ role: 'assistant', content: summaryMsg, timestamp: now });
        await saveConv(externalUserId, pharmacyConfig.id, state, history);
        return summaryMsg;
      }

      // ── PHASE: DELIVERY ─────────────────────────────────
      if (phase === 'delivery') {
        // Hard keyword shortcuts first
        if (!state.fulfilment) {
          let resolved = null;
          if (msg === '1' || msg.includes('deliver')) resolved = 'DELIVERY';
          else if (msg === '2' || msg.includes('pickup') || msg.includes('pick up') || msg.includes('collect')) resolved = 'PICKUP';

          if (resolved) {
            state.fulfilment = resolved;
            if (resolved === 'PICKUP') {
              state.phase = 'confirm';
              const { msg: summaryMsg } = buildOrderSummary(state.cart, 'PICKUP', null, pharmacyConfig.delivery_fee, currency);
              history.push({ role: 'assistant', content: summaryMsg, timestamp: now });
              await saveConv(externalUserId, pharmacyConfig.id, state, history);
              return summaryMsg;
            }
            const areaQ = `What area should we deliver to?`;
            history.push({ role: 'assistant', content: areaQ, timestamp: now });
            await saveConv(externalUserId, pharmacyConfig.id, state, history);
            return areaQ;
          }
        }

        if (state.fulfilment === 'DELIVERY' && !state.delivery_area) {
          state.delivery_area = message.trim();
          state.phase = 'confirm';
          const { msg: summaryMsg } = buildOrderSummary(state.cart, 'DELIVERY', state.delivery_area, pharmacyConfig.delivery_fee, currency);
          history.push({ role: 'assistant', content: summaryMsg, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return summaryMsg;
        }

        // Ask AI for delivery intent disambiguation
        const allProds = await adapter.getProducts();
        const aiResp = await pharmacyAI(message, history.slice(-20), state, allProds, pharmacyConfig.pharmacy_name);

        if (aiResp.extracted?.fulfilment && !state.fulfilment) {
          state.fulfilment = aiResp.extracted.fulfilment.toUpperCase();
          if (state.fulfilment === 'PICKUP') {
            state.phase = 'confirm';
            const { msg: summaryMsg } = buildOrderSummary(state.cart, 'PICKUP', null, pharmacyConfig.delivery_fee, currency);
            history.push({ role: 'assistant', content: summaryMsg, timestamp: now });
            await saveConv(externalUserId, pharmacyConfig.id, state, history);
            return summaryMsg;
          }
        }
        if (aiResp.extracted?.delivery_area && state.fulfilment === 'DELIVERY' && !state.delivery_area) {
          state.delivery_area = aiResp.extracted.delivery_area;
          state.phase = 'confirm';
          const { msg: summaryMsg } = buildOrderSummary(state.cart, 'DELIVERY', state.delivery_area, pharmacyConfig.delivery_fee, currency);
          history.push({ role: 'assistant', content: summaryMsg, timestamp: now });
          await saveConv(externalUserId, pharmacyConfig.id, state, history);
          return summaryMsg;
        }

        const fallback = aiResp.reply || `How would you like to receive your order?\n\n1. Delivery\n2. Pickup`;
        history.push({ role: 'assistant', content: fallback, timestamp: now });
        await saveConv(externalUserId, pharmacyConfig.id, state, history);
        return fallback;
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
        // Media attachment = prescription upload
        if (mediaAttachment && mediaAttachment.mediaId) {
          try {
            const buffer = await downloadMedia(mediaAttachment.mediaId);
            const { url } = await adapter.savePrescription({
              buffer,
              mimetype : mediaAttachment.mediaMime   || 'application/octet-stream',
              filename : mediaAttachment.mediaFilename || `rx_${Date.now()}.bin`,
            });
            state.prescription_url = url;
            state.rx_confirmed = true;
            addLog('info', `Prescription uploaded for ${externalUserId}: ${url}`);
          } catch (e) {
            addLog('error', 'Prescription upload failed', e.message);
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
      const aiResp = await pharmacyAI(message || '', history.slice(-20), state, allProducts, pharmacyConfig.pharmacy_name);

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

  return { processPharmacyMessage };
}

module.exports = { createPharmacyProcessor };
