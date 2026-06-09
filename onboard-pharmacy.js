#!/usr/bin/env node
'use strict';

/**
 * onboard-pharmacy.js — Zero Pharmacy tenant onboarding (adapter architecture)
 *
 * Registers a pharmacy in pharmacy_config, generates a unique widget_key,
 * and prints the embed snippet + setup checklist. No deployment required.
 *
 * Usage:
 *   node onboard-pharmacy.js \
 *     --name            "Ochesta Pharmacy"           (required)
 *     --timezone        "Africa/Lagos"               (default)
 *     --adapter         supabase                     (default: supabase | native)
 *     --supabase-url    "https://xyz.supabase.co"   (required for supabase)
 *     --service-key-env OCHESTA_SERVICE_KEY          (env-var NAME, not the key itself)
 *     [--handoff-number "+2348012345678"]
 *     [--delivery-fee   500]
 *     [--currency       NGN]
 *     [--auth-mode      supabase_jwt]
 *     [--table-products  products]
 *     [--table-orders    orders]
 *     [--bucket-rx       prescriptions]
 *     [--dry-run]
 *
 * SECRETS — never pass on the command line (they appear in shell history):
 *   --service-key-env accepts an ENV VAR NAME only (e.g. OCHESTA_SERVICE_KEY).
 *   The actual Supabase service role key is set as that variable in Railway
 *   (Settings → Variables). It is NEVER stored in pharmacy_config.
 *
 * DATABASE_URL is read from .env (the same file the server uses).
 */

require('dotenv').config();
const { Pool } = require('pg');
const crypto   = require('crypto');

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const b  = s => `\x1b[1m${s}\x1b[0m`;
const d  = s => `\x1b[2m${s}\x1b[0m`;
const g  = s => `\x1b[32m${s}\x1b[0m`;
const y  = s => `\x1b[33m${s}\x1b[0m`;
const r  = s => `\x1b[31m${s}\x1b[0m`;
const c  = s => `\x1b[36m${s}\x1b[0m`;
const bl = s => `\x1b[34m${s}\x1b[0m`;
const HR  = d('─'.repeat(64));
const HR2 = d('═'.repeat(64));
const OK  = g('✔');
const WRN = y('⚠');

// ── Arg parser ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key  = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) { a[key] = true; }
    else { a[key] = next; i++; }
  }
  return a;
}

function fail(msg) {
  console.error(r(`\nError: ${msg}\n`));
  process.exit(1);
}

function usage() {
  console.error(
    `\nUsage:\n  node onboard-pharmacy.js \\\n` +
    `    --name            "Pharmacy Name"              ${d('required')}\n` +
    `    --timezone        "Africa/Lagos"               ${d('default: Africa/Lagos')}\n` +
    `    --adapter         supabase                     ${d('default: supabase | native')}\n` +
    `    --supabase-url    "https://xyz.supabase.co"   ${d('required for supabase adapter')}\n` +
    `    --service-key-env OCHESTA_SERVICE_KEY          ${d('env-var NAME — not the key value')}\n` +
    `    [--handoff-number "+2348012345678"]\n` +
    `    [--delivery-fee   500]\n` +
    `    [--currency       NGN]\n` +
    `    [--auth-mode      supabase_jwt]\n` +
    `    [--table-products  products]   ${d('table name in Supabase')}\n` +
    `    [--table-orders    orders]     ${d('table name in Supabase')}\n` +
    `    [--bucket-rx       prescriptions] ${d('storage bucket name')}\n` +
    `    [--dry-run]\n`
  );
  process.exit(1);
}

// ── Timezone validation ───────────────────────────────────────────────────────
function validateTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ── Widget key generation ─────────────────────────────────────────────────────
// zp_ prefix + 24 hex chars = 27 total. ~2^96 unique values — collision is
// astronomically unlikely but we check uniqueness in the DB anyway.
function genWidgetKey() {
  return 'zp_' + crypto.randomBytes(12).toString('hex');
}

async function uniqueWidgetKey(pool, maxAttempts = 5) {
  for (let i = 0; i < maxAttempts; i++) {
    const key = genWidgetKey();
    const { rows } = await pool.query(
      'SELECT id FROM pharmacy_config WHERE widget_key = $1', [key]
    );
    if (rows.length === 0) return key;
  }
  throw new Error('Failed to generate a unique widget_key after 5 attempts.');
}

// ── Embed snippet (vanilla JS + minimal demo UI) ──────────────────────────────
function embedSnippet(widgetKey, currency) {
  return `<!-- ═══════════════════ Zero Pharmacy Widget ══════════════════════
  1. Paste this block before </body> on every page the chat should appear.
  2. Set ZERO_API to your Zero Pharmacy server URL (Railway domain).
  3. Do NOT change WIDGET_KEY — it identifies your account.
  4. Remove the "minimal demo UI" section once your own chat UI is wired up.
  ══════════════════════════════════════════════════════════════════════ -->
<div id="zero-chat-root"></div>
<script>
(function () {
  /* ── configuration ─────────────────────────────────────────────────── */
  var ZERO_API   = 'https://YOUR-ZERO-API.railway.app'; // ← your server URL
  var WIDGET_KEY = '${widgetKey}';                        // ← do not change
  var CURRENCY   = '${currency}';

  /* ── stable session ID (guest users) ───────────────────────────────── */
  var SESSION_KEY = 'zp_sid_' + WIDGET_KEY;
  var sessionId   = sessionStorage.getItem(SESSION_KEY) || null;

  /* ── send(text, identityToken?, attachment?) ────────────────────────
     identityToken: Supabase access_token for logged-in users.
                    Pass it so Zero greets by name and offers reorders.
                    For guests, leave it undefined or null.
     attachment:    a File object (image/PDF prescription).
  ─────────────────────────────────────────────────────────────────── */
  function send(text, identityToken, attachment) {
    var body = new FormData();
    body.append('widgetKey', WIDGET_KEY);
    if (text)          body.append('text',           text);
    if (sessionId)     body.append('conversationId', sessionId);
    if (identityToken) body.append('identityToken',  identityToken);
    if (attachment)    body.append('attachment',     attachment);

    return fetch(ZERO_API + '/api/web/message', { method: 'POST', body: body })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (e) {
          throw new Error(e.error || 'Request failed (' + res.status + ')');
        });
        return res.json();
      })
      .then(function (data) {
        /* data = { conversationId, reply, actions } */
        if (data.conversationId) {
          sessionId = data.conversationId;
          sessionStorage.setItem(SESSION_KEY, sessionId);
        }
        if (window.ZeroWidget.onReply) window.ZeroWidget.onReply(data);
        return data;
      });
  }

  /* ── handoff(reason?) ───────────────────────────────────────────────
     Flags the conversation for staff review and returns a WhatsApp
     deep link the user can tap to continue on WhatsApp.
  ─────────────────────────────────────────────────────────────────── */
  function handoff(reason) {
    return fetch(ZERO_API + '/api/web/handoff', {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({
        widgetKey      : WIDGET_KEY,
        conversationId : sessionId,
        reason         : reason || null,
      }),
    })
    .then(function (res) { return res.json(); });
    /* returns { flagged: true, whatsapp_link: "https://wa.me/..." } */
  }

  /* ── public API ─────────────────────────────────────────────────── */
  window.ZeroWidget = {
    widgetKey : WIDGET_KEY,
    currency  : CURRENCY,
    send      : send,
    handoff   : handoff,
    onReply   : null, // assign: window.ZeroWidget.onReply = function(data) { ... }
  };

  /* ── actions hint handler ────────────────────────────────────────
     Zero returns action hints alongside each reply:
       { type: 'request_attachment', accept: '...', maxMB: 10, label: 'Send Prescription' }
       { type: 'whatsapp_handoff', url: 'https://wa.me/...', label: 'Chat on WhatsApp' }
     Wire these to your UI to show file pickers / handoff buttons.
  ─────────────────────────────────────────────────────────────────── */

  /* ── minimal demo UI ─────────────────────────────────────────────
     A floating chat panel so you can test the integration immediately.
     Replace with your own UI — just call window.ZeroWidget.send().
  ─────────────────────────────────────────────────────────────────── */
  (function buildDemoUI() {
    var root = document.getElementById('zero-chat-root');
    if (!root) return;

    root.innerHTML =
      '<div id="_zp_box" style="position:fixed;bottom:24px;right:24px;width:340px;' +
      'max-height:520px;display:flex;flex-direction:column;border-radius:14px;overflow:hidden;' +
      'box-shadow:0 8px 40px rgba(0,0,0,.16);font-family:system-ui,sans-serif;font-size:14px;z-index:9999">' +
        '<div style="background:#0d7fe8;color:#fff;padding:14px 16px;font-weight:600;' +
             'display:flex;align-items:center;justify-content:space-between">' +
          '<span>Zero Pharmacy</span>' +
          '<button id="_zp_close" style="background:none;border:none;color:#fff;font-size:18px;' +
                  'cursor:pointer;line-height:1" title="Close">&times;</button>' +
        '</div>' +
        '<div id="_zp_msgs" style="flex:1;overflow-y:auto;padding:12px;display:flex;' +
             'flex-direction:column;gap:8px;background:#fff"></div>' +
        '<div style="display:flex;border-top:1px solid #e5e7eb;padding:8px 10px;background:#fff">' +
          '<input id="_zp_input" placeholder="Type a message…" autocomplete="off" ' +
                 'style="flex:1;border:1px solid #d1d5db;border-radius:6px;padding:6px 10px;' +
                        'outline:none;font-size:14px"/>' +
          '<button id="_zp_send" style="margin-left:8px;background:#0d7fe8;color:#fff;border:none;' +
                  'border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:600">Send</button>' +
        '</div>' +
      '</div>';

    var msgs  = document.getElementById('_zp_msgs');
    var input = document.getElementById('_zp_input');
    var btn   = document.getElementById('_zp_send');
    var box   = document.getElementById('_zp_box');

    document.getElementById('_zp_close').addEventListener('click', function () {
      box.style.display = 'none';
    });

    function bubble(text, side) {
      var el = document.createElement('div');
      el.style.cssText =
        'max-width:82%;padding:9px 13px;border-radius:10px;line-height:1.45;white-space:pre-wrap;word-break:break-word;' +
        (side === 'user'
          ? 'align-self:flex-end;background:#0d7fe8;color:#fff;'
          : 'align-self:flex-start;background:#f3f4f6;color:#111;');
      el.textContent = text;
      msgs.appendChild(el);
      msgs.scrollTop = msgs.scrollHeight;
    }

    function submit() {
      var text = input.value.trim();
      if (!text || btn.disabled) return;
      bubble(text, 'user');
      input.value  = '';
      btn.disabled = true;
      send(text)
        .then(function (d) { bubble(d.reply, 'zero'); })
        .catch(function (e) { bubble('Sorry, something went wrong. Please try again.', 'zero'); console.error(e); })
        .finally(function () { btn.disabled = false; input.focus(); });
    }

    btn.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });

    // Auto-greet: send "Hi" to get the welcome message as soon as the widget opens.
    // The START state returns the greeting regardless of message content.
    btn.disabled = true;
    send('Hi')
      .then(function (d) { bubble(d.reply, 'zero'); })
      .catch(function () {})
      .finally(function () { btn.disabled = false; });
  })();
})();
</script>
<!-- ══════════════════════════════════════════════════════════════════ -->

<!-- React / Next.js example (if using a component framework):

import { useEffect, useRef } from 'react';

export function ZeroChat({ identityToken }) {
  const sessionRef = useRef(null);

  async function sendMessage(text, attachment) {
    const body = new FormData();
    body.append('widgetKey', '${widgetKey}');
    body.append('text', text);
    if (sessionRef.current) body.append('conversationId', sessionRef.current);
    if (identityToken)      body.append('identityToken',  identityToken);
    if (attachment)         body.append('attachment',     attachment);

    const res  = await fetch(ZERO_API + '/api/web/message', { method: 'POST', body });
    const data = await res.json();
    if (data.conversationId) sessionRef.current = data.conversationId;
    return data; // { reply, actions }
  }

  // ... render your UI, call sendMessage on submit ...
}
-->`;
}

// ── Setup checklist ───────────────────────────────────────────────────────────
function printChecklist(opts) {
  const {
    name, widgetKey, pharmacyId, adapterType,
    supabaseUrl, serviceKeyEnv, bucketRx,
    tableProducts, tableOrders, handoffNumber,
    dryRun,
  } = opts;

  const ZERO_API = 'https://YOUR-ZERO-API.railway.app';

  console.log(`\n${HR2}`);
  console.log(b(c('  Setup checklist')));
  if (dryRun) console.log(y('  (DRY RUN — steps shown for reference; nothing was written)'));
  console.log(HR2);

  // ── Step 1: Set the service role key env var on the server ─────────────────
  console.log(`\n${b(bl('Step 1 — Set the Supabase service role key in Railway'))}`);
  console.log(`  The adapter_config stored in the DB holds only the env-var NAME:`);
  console.log(`    ${b('service_key_env')} = ${b(serviceKeyEnv || 'OCHESTA_SERVICE_KEY')}`);
  console.log(`\n  Set the ACTUAL service role key (${b('secret — never paste here')}):`);
  console.log(`    Railway → your project → Variables → New Variable`);
  console.log(`    Name  : ${b(serviceKeyEnv || 'OCHESTA_SERVICE_KEY')}`);
  console.log(`    Value : ${b('<Supabase service role key>')}`);
  console.log(`             (Supabase → Project Settings → API → service_role)`);
  console.log(`\n  ${WRN} ${y('The service role key bypasses RLS — keep it server-side only.')}`);
  console.log(`  ${d('It must never appear in browser code, logs, or responses.')}`);

  // ── Step 2: Supabase storage bucket ───────────────────────────────────────
  if (adapterType === 'supabase') {
    const rxBucket = bucketRx || 'prescriptions';
    console.log(`\n${b(bl('Step 2 — Enable the Supabase storage bucket'))}`);
    console.log(`  Bucket  : ${b(rxBucket)}`);
    console.log(`  Go to   : Supabase → Storage → New bucket`);
    console.log(`  Name    : ${b(rxBucket)}`);
    console.log(`  Public  : ${b('yes')}  ${d('(presigned URLs are generated server-side)')}`);
    console.log(`\n  Make sure the service role has INSERT access (it does by default).`);
    console.log(`  If RLS is enabled on the bucket, add a policy that allows the service role.`);

    // ── Step 3: Supabase tables ──────────────────────────────────────────────
    const tProducts = tableProducts || 'products';
    const tOrders   = tableOrders   || 'orders';
    console.log(`\n${b(bl('Step 3 — Verify Supabase table schema'))}`);
    console.log(`  Required tables (must exist in ${b(supabaseUrl || 'your Supabase project')}):\n`);
    console.log(`  ${b(tProducts)} columns used by Zero:`);
    console.log(`    ${d('id, name, price, stock_qty, requires_prescription')}`);
    console.log(`    ${d('(category, description, image_url are optional but recommended)')}`);
    console.log(`\n  ${b(tOrders)} columns used by Zero:`);
    console.log(`    ${d('id TEXT PRIMARY KEY  (Zero writes OCP-XXXXXX format IDs)')}`);
    console.log(`    ${d('customer_name, customer_phone, total_amount, status, items JSONB')}`);
    console.log(`    ${d('items JSONB shape: { cart: [{product_id, name, price, quantity}],...}')}`);

    // ── Step 4: decrement_stock RPC (optional but recommended) ──────────────
    console.log(`\n${b(bl('Step 4 — (Recommended) Install the atomic stock decrement RPC'))}`);
    console.log(`  Without this, stock is decremented per-item (not atomic).`);
    console.log(`  Paste this once in Supabase → SQL Editor:\n`);
    console.log(c(
`  CREATE OR REPLACE FUNCTION decrement_stock(items jsonb)
  RETURNS void LANGUAGE plpgsql AS $$
  DECLARE r jsonb;
  BEGIN
    FOR r IN SELECT * FROM jsonb_array_elements(items)
    LOOP
      UPDATE products
        SET stock_qty = GREATEST(stock_qty - (r->>'qty')::int, 0)
        WHERE id = (r->>'product_id');
    END LOOP;
  END; $$;`
    ));

    console.log(`\n${b(bl('Step 5 — Paste the embed snippet into the pharmacy website'))}`);
  } else {
    console.log(`\n${b(bl('Step 2 — Paste the embed snippet into the pharmacy website'))}`);
  }

  const stepN = adapterType === 'supabase' ? 5 : 2;
  console.log(`  Replace ${b('YOUR-ZERO-API.railway.app')} with your actual Railway domain.`);
  if (handoffNumber) {
    console.log(`  Handoff number ${b(handoffNumber)} is configured — the widget will show`);
    console.log(`  a "Chat on WhatsApp" button when Zero flags a conversation.`);
  }
  console.log(`  Widget key: ${b(widgetKey)}`);
  console.log(`  ${d('(printed in full below)')}`);

  // ── Step N+1: Smoke test ──────────────────────────────────────────────────
  const smokeStep = adapterType === 'supabase' ? 6 : 3;
  console.log(`\n${b(bl(`Step ${smokeStep} — Smoke test`))}`);
  console.log(`  curl -s -X POST ${b(`${ZERO_API}/api/web/message`)} \\`);
  console.log(`       -F "widgetKey=${widgetKey}" \\`);
  console.log(`       -F "text=Hi" | python3 -m json.tool`);
  console.log(`\n  Expected: {"conversationId":"...","reply":"Good morning. Welcome...","actions":[]}`);

  // ── Kill switch ───────────────────────────────────────────────────────────
  console.log(`\n${HR}`);
  console.log(b('  Kill switch'));
  console.log(HR);
  console.log(`  To stop Zero responding for this pharmacy instantly (no deploy required):`);
  console.log(d(`\n  UPDATE pharmacy_config SET active = false WHERE id = ${pharmacyId !== undefined ? pharmacyId : '<id>'};`));
  console.log(`\n  Zero drops the next inbound message silently and returns HTTP 403 to`);
  console.log(`  the web widget. Re-enable with:`);
  console.log(d(`  UPDATE pharmacy_config SET active = true  WHERE id = ${pharmacyId !== undefined ? pharmacyId : '<id>'};`));
  console.log(`\n  Takes effect on the very next message — no restart required.\n`);

  console.log(HR2 + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  // Required
  const name           = args['name'];
  const adapterType    = (args['adapter'] || 'supabase').toLowerCase();

  // Adapter-specific
  const supabaseUrl    = args['supabase-url']    || null;
  const serviceKeyEnv  = args['service-key-env'] || null;

  // Optional
  const timezone       = args['timezone']       || 'Africa/Lagos';
  const handoffNumber  = args['handoff-number'] || null;
  const deliveryFee    = parseFloat(args['delivery-fee']  ?? '0');
  const currency       = (args['currency'] || 'NGN').toUpperCase();
  const authMode       = args['auth-mode'] || (adapterType === 'supabase' ? 'supabase_jwt' : 'none');
  const tableProducts  = args['table-products']  || 'products';
  const tableOrders    = args['table-orders']    || 'orders';
  const bucketRx       = args['bucket-rx']       || 'prescriptions';
  const dryRun         = args['dry-run'] === true;

  // ── Validate ──
  if (!name) usage();
  if (!['supabase', 'native'].includes(adapterType)) fail(`--adapter must be "supabase" or "native"`);
  if (adapterType === 'supabase' && !supabaseUrl)    fail(`--supabase-url is required for the supabase adapter`);
  if (adapterType === 'supabase' && !serviceKeyEnv)  fail(`--service-key-env is required for the supabase adapter`);
  if (!validateTimezone(timezone)) fail(`Invalid timezone "${timezone}". Use IANA format e.g. "Africa/Lagos".`);
  if (isNaN(deliveryFee) || deliveryFee < 0) fail(`--delivery-fee must be a non-negative number`);

  // Warn if the operator accidentally passed the key value instead of the var name
  if (serviceKeyEnv && (serviceKeyEnv.startsWith('eyJ') || serviceKeyEnv.length > 80)) {
    fail(
      `--service-key-env looks like a JWT token, not an env-var name.\n` +
      `  Pass the NAME of the env var (e.g. OCHESTA_SERVICE_KEY),\n` +
      `  not the actual key value.`
    );
  }

  // ── Build adapter_config — secrets by reference only ──────────────────────
  // The service role key is NEVER stored here. Only the env-var name is stored.
  // At runtime the server resolves: process.env[adapter_config.service_key_env]
  const adapterConfig = adapterType === 'supabase'
    ? {
        url             : supabaseUrl,
        service_key_env : serviceKeyEnv,
        tables          : { products: tableProducts, orders: tableOrders },
        storage         : { prescriptions: bucketRx },
      }
    : {};

  // ── Banner ────────────────────────────────────────────────────────────────
  console.log(`\n${HR2}`);
  console.log(b(c('  Zero Pharmacy — Tenant Onboarding')));
  if (dryRun) console.log(y('  DRY RUN — nothing will be written to the database'));
  console.log(`${HR2}\n`);

  // ── Plan summary ──────────────────────────────────────────────────────────
  console.log(`${HR}`);
  console.log(b('  Plan'));
  console.log(`${HR}`);
  console.log(`  Pharmacy name   : ${b(name)}`);
  console.log(`  Timezone        : ${timezone}`);
  console.log(`  Adapter         : ${adapterType}`);
  if (adapterType === 'supabase') {
    console.log(`  Supabase URL    : ${supabaseUrl}`);
    console.log(`  Service key env : ${b(serviceKeyEnv)} ${d('(env-var name — key NOT stored in DB)')}`);
    console.log(`  Tables          : ${tableProducts}, ${tableOrders}`);
    console.log(`  Bucket          : ${bucketRx}`);
  }
  console.log(`  Auth mode       : ${authMode}`);
  console.log(`  Handoff number  : ${handoffNumber || d('(none)')}`);
  console.log(`  Delivery fee    : ${currency} ${deliveryFee}`);
  console.log(`  Currency        : ${currency}`);
  console.log('');

  if (dryRun) {
    // Show a synthetic widget key so the snippet is legible in dry-run mode
    const syntheticKey = 'zp_' + 'dryrun00000000000000000000'.slice(0, 24);
    console.log(y('DRY RUN complete. Re-run without --dry-run to write to the database.\n'));
    console.log(`${HR2}`);
    console.log(b(c('  Embed snippet (dry-run preview)')));
    console.log(`${HR2}\n`);
    console.log(embedSnippet(syntheticKey, currency));
    printChecklist({
      name, widgetKey: syntheticKey, pharmacyId: undefined,
      adapterType, supabaseUrl, serviceKeyEnv, bucketRx,
      tableProducts, tableOrders, handoffNumber, dryRun: true,
    });
    return;
  }

  // ── Connect ───────────────────────────────────────────────────────────────
  if (!process.env.DATABASE_URL) {
    fail('DATABASE_URL is not set. Create a .env file or export it before running.');
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await pool.query('SELECT 1');
    console.log(`${OK} Database connected`);
  } catch (e) {
    console.error(r(`Database connection failed: ${e.message}`));
    process.exit(1);
  }

  // ── Idempotency check ─────────────────────────────────────────────────────
  // Unique constraint is on widget_key, but also guard on name + url to
  // prevent accidental double-onboarding of the same pharmacy.
  if (adapterType === 'supabase' && supabaseUrl) {
    const dup = await pool.query(
      `SELECT id, pharmacy_name, active
       FROM pharmacy_config
       WHERE adapter_config->>'url' = $1 LIMIT 1`,
      [supabaseUrl]
    );
    if (dup.rows.length > 0) {
      const row = dup.rows[0];
      console.log(y(`\n${WRN} A pharmacy already uses this Supabase URL:`));
      console.log(`   id=${row.id}  name="${row.pharmacy_name}"  active=${row.active}`);
      console.log(y('   Aborting to prevent a duplicate tenant. Update the row manually if needed.\n'));
      await pool.end();
      process.exit(1);
    }
  }

  // ── Generate unique widget key ────────────────────────────────────────────
  let widgetKey;
  try {
    widgetKey = await uniqueWidgetKey(pool);
  } catch (e) {
    console.error(r(e.message));
    await pool.end();
    process.exit(1);
  }
  console.log(`${OK} Widget key generated : ${b(widgetKey)}`);

  // ── Insert pharmacy_config ────────────────────────────────────────────────
  let pharmacyId;
  try {
    const res = await pool.query(
      `INSERT INTO pharmacy_config
         (pharmacy_name, widget_key, timezone, adapter_type, adapter_config,
          auth_mode, handoff_number, delivery_fee, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       RETURNING id`,
      [
        name, widgetKey, timezone, adapterType,
        JSON.stringify(adapterConfig),
        authMode,
        handoffNumber || null,
        deliveryFee,
      ]
    );
    pharmacyId = res.rows[0].id;
    console.log(`${OK} pharmacy_config inserted ${d(`id = ${pharmacyId}`)}`);
  } catch (e) {
    console.error(r(`INSERT failed: ${e.message}`));
    await pool.end();
    process.exit(1);
  }

  await pool.end();

  // ── Success banner ────────────────────────────────────────────────────────
  console.log(`\n${HR2}`);
  console.log(b(g('  ✔  Onboarding complete')));
  console.log(`${HR2}`);
  console.log(`  pharmacy_config.id = ${b(String(pharmacyId))}`);
  console.log(`  Pharmacy name      = ${b(name)}`);
  console.log(`  Widget key         = ${b(widgetKey)}`);
  console.log(`  Active             = ${g('true')}  ${d('(kill: SET active = false WHERE id = ' + pharmacyId + ')')}`);

  // ── Embed snippet ─────────────────────────────────────────────────────────
  console.log(`\n${HR2}`);
  console.log(b(c('  Embed snippet — paste before </body> on the pharmacy website')));
  console.log(`${HR2}\n`);
  console.log(embedSnippet(widgetKey, currency));

  // ── Setup checklist ───────────────────────────────────────────────────────
  printChecklist({
    name, widgetKey, pharmacyId,
    adapterType, supabaseUrl, serviceKeyEnv, bucketRx,
    tableProducts, tableOrders, handoffNumber, dryRun: false,
  });
}

main().catch(e => {
  console.error(r(`\nUnexpected error: ${e.message}\n${e.stack || ''}`));
  process.exit(1);
});
