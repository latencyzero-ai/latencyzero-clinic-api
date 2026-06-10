'use client';

/**
 * ZeroWidget — customer-facing pharmacy chat widget
 *
 * Props
 * ─────
 * widgetKey      string   required  — zp_... key from onboard-pharmacy.js
 * apiUrl         string   required  — Zero Pharmacy server (Railway) URL, no trailing slash
 * supabaseClient object   optional  — @supabase/supabase-js client
 *                                     When provided, getSession() is called on every send
 *                                     so the current user's access_token is attached.
 *                                     Omit for guest sessions.
 *
 * Network contract
 * ────────────────
 * All traffic flows through a single api() function.
 * sendToZero()      → POST /api/web/message  (multipart/form-data)
 *                     returns { conversationId, reply, actions }
 * requestHumanAgent → POST /api/web/handoff  (application/json)
 *                     returns { flagged, whatsapp_link }
 *
 * Action hints returned by the server
 * ─────────────────────────────────────
 * { type: 'request_attachment', accept, maxMB, label }
 *   → renders a button that opens a file picker (prescription upload)
 * { type: 'whatsapp_handoff', url, label }
 *   → calls requestHumanAgent (flags conversation for staff) then opens wa.me link
 */

import { useEffect, useRef, useState, useCallback } from 'react';

// sessionStorage key for this widget instance
const sessionKey = (wk) => `zp_sid_${wk}`;

export default function ZeroWidget({ widgetKey, apiUrl, supabaseClient }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState('');
  const [busy, setBusy]         = useState(false);
  const [actions, setActions]   = useState([]);

  const sessionId = useRef(null); // stable; mutations don't need a re-render
  const endRef    = useRef(null);
  const fileRef   = useRef(null);

  // Hydrate session from storage after first render (SSR-safe)
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(sessionKey(widgetKey));
      if (stored) sessionId.current = stored;
    } catch {}
  }, [widgetKey]);

  // ── Single network function ───────────────────────────────────────────────
  // Handles both multipart (sendToZero) and JSON (requestHumanAgent).
  // Throws an error with .status set so callers can branch on HTTP codes.
  const api = useCallback(
    async (endpoint, data) => {
      const isForm = data instanceof FormData;
      const res = await fetch(`${apiUrl}${endpoint}`, {
        method: 'POST',
        ...(isForm
          ? { body: data }
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err  = new Error(json.error || res.statusText || String(res.status));
        err.status = res.status;
        throw err;
      }
      return json;
    },
    [apiUrl],
  );

  // ── Supabase JWT ──────────────────────────────────────────────────────────
  const getToken = useCallback(async () => {
    if (!supabaseClient) return null;
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      return session?.access_token ?? null;
    } catch {
      return null;
    }
  }, [supabaseClient]);

  // ── Append a message bubble ───────────────────────────────────────────────
  const push = useCallback((role, content) => {
    setMessages(prev => [...prev, { id: crypto.randomUUID(), role, content }]);
  }, []);

  // ── sendToZero(text?, file?) ─────────────────────────────────────────────
  // POST /api/web/message — multipart/form-data
  // Either text or file must be present; both may be present (attachment + context text).
  const sendToZero = useCallback(
    async (text, file) => {
      const token = await getToken();

      const form = new FormData();
      form.append('widgetKey', widgetKey);
      if (sessionId.current) form.append('conversationId', sessionId.current);
      if (token)             form.append('identityToken',  token);
      if (text)              form.append('text',           text);
      if (file)              form.append('attachment',     file);

      const data = await api('/api/web/message', form);

      // Persist the server-assigned conversation ID so subsequent messages
      // are routed to the same conversation state machine.
      if (data.conversationId) {
        sessionId.current = data.conversationId;
        try { sessionStorage.setItem(sessionKey(widgetKey), data.conversationId); } catch {}
      }

      return data; // { conversationId, reply, actions }
    },
    [widgetKey, api, getToken],
  );

  // ── requestHumanAgent() ──────────────────────────────────────────────────
  // POST /api/web/handoff — JSON
  // Flags the conversation for staff review, then opens the returned wa.me link.
  const requestHumanAgent = useCallback(
    async (fallbackUrl) => {
      const data = await api('/api/web/handoff', {
        widgetKey,
        ...(sessionId.current ? { conversationId: sessionId.current } : {}),
      });
      const link = data.whatsapp_link || fallbackUrl || null;
      if (link) window.open(link, '_blank', 'noopener,noreferrer');
      return data;
    },
    [widgetKey, api],
  );

  // ── Init: fetch greeting on mount ────────────────────────────────────────
  // Sends 'Hi' so the server returns the welcome message (START state) or
  // resumes wherever the conversation was (MENU/ACTIVE/DONE).
  // The Supabase JWT is attached so identified users are greeted by name.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const data = await sendToZero('Hi');
        if (!live) return;
        push('assistant', data.reply);
        setActions(data.actions ?? []);
      } catch {
        if (!live) return;
        push('assistant', 'Unable to connect. Check your internet connection and refresh the page.');
      }
    })();
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — intentional mount-only

  // ── Handle text submit ────────────────────────────────────────────────────
  async function handleSubmit(e) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    push('user', text);
    setInput('');
    setBusy(true);
    setActions([]);

    try {
      const data = await sendToZero(text);
      push('assistant', data.reply);
      setActions(data.actions ?? []);
    } catch (err) {
      push(
        'assistant',
        err.status === 403
          ? 'This pharmacy is not currently taking orders.'
          : err.status === 404
          ? 'Pharmacy not found. Confirm the widget key is correct.'
          : 'Message not delivered. Check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  // ── Handle prescription upload ────────────────────────────────────────────
  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // allow re-sending the same file

    push('user', `Sent: ${file.name}`);
    setBusy(true);
    setActions([]);

    try {
      const data = await sendToZero(null, file);
      push('assistant', data.reply);
      setActions(data.actions ?? []);
    } catch (err) {
      const msg = err.message ?? '';
      push(
        'assistant',
        /large|10\s?mb/i.test(msg)
          ? 'File too large. Maximum allowed size is 10 MB.'
          : /type|jpeg|png|pdf|webp/i.test(msg)
          ? 'Unsupported file type. Send a JPEG, PNG, WebP image or PDF.'
          : 'File not received. Try again or contact the pharmacy directly.',
      );
    } finally {
      setBusy(false);
    }
  }

  // ── Handle action-hint buttons ────────────────────────────────────────────
  async function handleAction(action) {
    if (action.type === 'request_attachment') {
      fileRef.current?.click();
      return;
    }

    if (action.type === 'whatsapp_handoff') {
      setBusy(true);
      try {
        // Flag the conversation for staff, then open the wa.me link.
        // Falls back to the URL in the action hint if the API call fails
        // so the customer can still reach WhatsApp even during outages.
        await requestHumanAgent(action.url);
      } catch {
        if (action.url) {
          window.open(action.url, '_blank', 'noopener,noreferrer');
        } else {
          push('assistant', 'WhatsApp handoff unavailable. Contact the pharmacy directly.');
        }
      } finally {
        setBusy(false);
      }
    }
  }

  // ── Scroll to latest message ──────────────────────────────────────────────
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        display       : 'flex',
        flexDirection : 'column',
        height        : '100%',
        fontFamily    : 'system-ui, -apple-system, sans-serif',
        fontSize      : 14,
        lineHeight    : 1.5,
        color         : '#111',
        background    : '#fff',
      }}
    >
      {/* ── Message list ─────────────────────────────────────────────────── */}
      <div
        style={{
          flex          : 1,
          overflowY     : 'auto',
          padding       : '12px 16px',
          display       : 'flex',
          flexDirection : 'column',
          gap           : 8,
        }}
      >
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              alignSelf  : m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth   : '82%',
              padding    : '9px 13px',
              borderRadius: 10,
              whiteSpace : 'pre-wrap',
              wordBreak  : 'break-word',
              background : m.role === 'user' ? '#0d7fe8' : '#f3f4f6',
              color      : m.role === 'user' ? '#fff'    : '#111',
            }}
          >
            {m.content}
          </div>
        ))}

        {/* Typing indicator */}
        {busy && (
          <div
            style={{
              alignSelf   : 'flex-start',
              padding     : '9px 13px',
              background  : '#f3f4f6',
              borderRadius: 10,
              color       : '#888',
              fontSize    : 13,
            }}
          >
            Typing…
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* ── Action-hint buttons ───────────────────────────────────────────── */}
      {actions.length > 0 && (
        <div
          style={{
            padding   : '4px 16px 8px',
            display   : 'flex',
            gap       : 8,
            flexWrap  : 'wrap',
          }}
        >
          {actions.map((a, i) => (
            <button
              key={i}
              onClick={() => handleAction(a)}
              disabled={busy}
              style={{
                padding     : '6px 14px',
                borderRadius: 6,
                border      : '1.5px solid #0d7fe8',
                background  : '#fff',
                color       : '#0d7fe8',
                cursor      : busy ? 'default' : 'pointer',
                fontSize    : 13,
                fontWeight  : 600,
                opacity     : busy ? 0.5 : 1,
                transition  : 'opacity 0.15s',
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Input row ─────────────────────────────────────────────────────── */}
      <form
        onSubmit={handleSubmit}
        style={{
          display   : 'flex',
          borderTop : '1px solid #e5e7eb',
          padding   : '10px 12px',
          gap       : 8,
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          disabled={busy}
          autoComplete="off"
          style={{
            flex        : 1,
            border      : '1px solid #d1d5db',
            borderRadius: 6,
            padding     : '7px 11px',
            fontSize    : 14,
            outline     : 'none',
            background  : busy ? '#fafafa' : '#fff',
          }}
        />
        <button
          type="submit"
          disabled={!input.trim() || busy}
          style={{
            background  : '#0d7fe8',
            color       : '#fff',
            border      : 'none',
            borderRadius: 6,
            padding     : '7px 18px',
            fontSize    : 14,
            fontWeight  : 600,
            cursor      : !input.trim() || busy ? 'default' : 'pointer',
            opacity     : !input.trim() || busy ? 0.5 : 1,
            transition  : 'opacity 0.15s',
          }}
        >
          Send
        </button>
      </form>

      {/* Hidden file input — triggered by the 'request_attachment' action */}
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        style={{ display: 'none' }}
        onChange={handleFile}
      />
    </div>
  );
}
