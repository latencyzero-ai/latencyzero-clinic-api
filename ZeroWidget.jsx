'use client';

/* ============================================================================
 * FROZEN — NOT THE MAINTAINED WIDGET. DO NOT EDIT FOR FEATURE/STYLE CHANGES.
 *
 * The canonical, deployed widget is the hosted script generated in index.js
 * and served at  GET /widget/:widgetKey.js  — that one embeds on any site with
 * a single <script> tag and is themed per tenant from pharmacy_config.theme.
 * It already has feature parity with this component (tappable menu, attachment
 * upload, WhatsApp handoff).
 *
 * This React component is kept only as a reference / drop-in for a future
 * React-client offering. It is NOT used by any live site. Make all widget UI
 * and behaviour changes in the hosted script in index.js — changing only this
 * file will not affect any customer.
 * ========================================================================== */

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  Send,
  Paperclip,
  Minus,
  Maximize2,
  Minimize2,
  X,
  Headset,
  ShoppingBag,
  CalendarCheck,
  HelpCircle,
} from "lucide-react";

/**
 * ZeroWidget — on-site AI chat widget for Zero Pharmacy clients.
 *
 * Single-file, drop-in. No external state libs. Conversation state lives
 * server-side; this component holds only in-session UI state.
 *
 * Props
 * ─────
 * widgetKey      string   required  — zp_... key from onboard-pharmacy.js
 * apiUrl         string   required  — Zero Pharmacy server URL, no trailing slash
 * pharmacyName   string   optional  — display name in the widget header
 *                                     (server value from widget-config wins when
 *                                     this prop is omitted)
 * supabaseClient object   optional  — @supabase/supabase-js client
 *                                     When provided, the current user's JWT is
 *                                     attached so Zero can personalise the greeting
 *                                     and offer reorders for logged-in users.
 *                                     Omit for guest-only sites.
 *
 * Theming (per tenant — never a code fork)
 * ────────────────────────────────────────
 * On mount the widget fetches GET /api/web/widget-config?widgetKey=... and
 * merges the tenant's theme JSONB (pharmacy_config.theme, migration 005) over
 * DEFAULT_TOKENS. Recognised keys — all optional, missing keys keep defaults:
 *   accent, ink, surface, canvas, userBubble   → token overrides (any
 *   DEFAULT_TOKENS key is accepted, e.g. tint, line, accentInk)
 *   fontFamily        → replaces the default font stack
 *   logoUrl           → replaces the Zero mark in the launcher and header
 *   agentDisplayName  → assistant name (header, intro fallback, composer)
 * FAIL SOFT: if the fetch fails or returns junk, the widget renders with the
 * built-in defaults — theming must never break the widget.
 *
 * Network contract (conversation traffic through one function)
 * ─────────────────────────────────────────────────────────────
 * callApi(endpoint, data)
 *   sendToZero()       → POST /api/web/message  multipart/form-data
 *                        returns { conversationId, reply, actions }
 *   requestHumanAgent  → POST /api/web/handoff  application/json
 *                        returns { flagged, whatsapp_link }
 */

const SESSION_PREFIX = "zp_sid_";

const MENU_ITEMS = [
  { id: "order",        label: "Place an order",      sub: "Browse and buy",          Icon: ShoppingBag  },
  { id: "consultation", label: "Book consultation",   sub: "Speak to a pharmacist",   Icon: CalendarCheck },
  { id: "enquiry",      label: "Make an enquiry",     sub: "Ask a question",          Icon: HelpCircle   },
];

const DEFAULTS = {
  pharmacyName   : "Pharmacy",
  widgetKey      : "",
  apiUrl         : "",
  supabaseClient : null,
};

// ── Design tokens (defaults — overridable per tenant via widget-config) ───────
const DEFAULT_TOKENS = {
  ink       : "#0F1B2D",
  inkSoft   : "#33415A",
  sub       : "#7A869A",
  line      : "#E7EAF0",
  surface   : "#FFFFFF",
  canvas    : "#F4F6F9",
  tint      : "#F1F4F8",
  tintHover : "#E7ECF3",
  userBubble: "#0F1B2D",
  accent    : "#1F9E8A",
  accentInk : "#FFFFFF",
};

const DEFAULT_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';

// Merges a tenant theme object over the defaults. Only string values are
// accepted, and unfilled '<<FILL_ME' seed placeholders are skipped, so a
// half-configured theme can never break styling.
function mergeTheme(theme) {
  const out = {
    tokens   : { ...DEFAULT_TOKENS },
    font     : DEFAULT_FONT,
    logoUrl  : null,
    agentName: null,
  };
  if (!theme || typeof theme !== "object") return out;

  const ok = v => typeof v === "string" && v.trim() && !v.includes("<<FILL_ME");

  for (const key of Object.keys(DEFAULT_TOKENS)) {
    if (ok(theme[key])) out.tokens[key] = theme[key].trim();
  }
  if (ok(theme.fontFamily))       out.font      = theme.fontFamily.trim();
  if (ok(theme.logoUrl))          out.logoUrl   = theme.logoUrl.trim();
  if (ok(theme.agentDisplayName)) out.agentName = theme.agentDisplayName.trim();

  return out;
}

export default function ZeroWidget(props) {
  const cfg = { ...DEFAULTS, ...props };

  const [open,     setOpen]     = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState([]);   // populated by init effect
  const [draft,    setDraft]    = useState("");
  const [attach,   setAttach]   = useState(null);
  const [sending,  setSending]  = useState(false);
  const [menuUsed, setMenuUsed] = useState(false);

  // Tenant branding — starts as defaults, replaced by widget-config on mount.
  const [brand, setBrand] = useState(() => ({ ...mergeTheme(null), pharmacyName: null }));

  const T            = brand.tokens;
  const agentName    = brand.agentName || "Zero";
  const pharmacyName = props.pharmacyName || brand.pharmacyName || cfg.pharmacyName;

  // Styles are derived from the state-held tokens, so a theme arriving after
  // mount restyles the whole widget in one render.
  const S = useMemo(() => makeStyles(T, brand.font), [T, brand.font]);

  const sessionId  = useRef(null);
  const scrollRef  = useRef(null);
  const fileRef    = useRef(null);
  const inputRef   = useRef(null);

  // ── Session persistence ───────────────────────────────────────────────────
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(SESSION_PREFIX + cfg.widgetKey);
      if (stored) sessionId.current = stored;
    } catch {}
  }, [cfg.widgetKey]);

  // ── Tenant theme: fetch widget-config on mount ────────────────────────────
  // FAIL SOFT by design — any error leaves the defaults in place.
  useEffect(() => {
    if (!cfg.widgetKey || !cfg.apiUrl) return;
    let live = true;
    (async () => {
      try {
        const res = await fetch(
          `${cfg.apiUrl}/api/web/widget-config?widgetKey=${encodeURIComponent(cfg.widgetKey)}`
        );
        if (!res.ok) return;
        const data = await res.json();
        if (!live || !data || typeof data !== "object") return;
        setBrand({
          ...mergeTheme(data.theme),
          pharmacyName: typeof data.pharmacyName === "string" ? data.pharmacyName : null,
        });
      } catch {
        /* fail soft — keep defaults */
      }
    })();
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — mount-only

  // ── Scroll to bottom ──────────────────────────────────────────────────────
  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sending, open, expanded]);

  // ── Supabase JWT ──────────────────────────────────────────────────────────
  async function getToken() {
    if (!cfg.supabaseClient) return null;
    try {
      const { data: { session } } = await cfg.supabaseClient.auth.getSession();
      return session?.access_token ?? null;
    } catch {
      return null;
    }
  }

  // ── Single network function ───────────────────────────────────────────────
  // callApi handles both multipart (messages) and JSON (handoff) in one place.
  const callApi = useCallback(
    async (endpoint, data) => {
      const isForm = data instanceof FormData;
      const res = await fetch(`${cfg.apiUrl}${endpoint}`, {
        method : "POST",
        ...(isForm
          ? { body: data }
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err  = new Error(json.error || res.statusText || String(res.status));
        err.status = res.status;
        throw err;
      }
      return json;
    },
    [cfg.apiUrl],
  );

  // ── sendToZero({ text, file, intent }) → reply string ────────────────────
  // This is the primary network call. Returns the reply text so callers
  // can push it into the message list.
  const sendToZero = useCallback(
    async ({ text, file, intent }) => {
      const token = await getToken();

      const form = new FormData();
      form.append("widgetKey", cfg.widgetKey);
      if (sessionId.current) form.append("conversationId", sessionId.current);
      if (token)             form.append("identityToken",  token);
      if (intent)            form.append("intent",         intent);
      if (text)              form.append("text",           text);
      if (file)              form.append("attachment",     file);

      const data = await callApi("/api/web/message", form);

      if (data.conversationId) {
        sessionId.current = data.conversationId;
        try { sessionStorage.setItem(SESSION_PREFIX + cfg.widgetKey, data.conversationId); } catch {}
      }

      return data.reply;    // string — same shape as the mocked version
    },
    [cfg.widgetKey, callApi],
  );

  // ── requestHumanAgent() ───────────────────────────────────────────────────
  // Flags the conversation for staff in the dashboard, then opens the
  // returned wa.me deep-link. Falls back to a chat message if no number
  // is configured on the server.
  const requestHumanAgent = useCallback(
    async () => {
      try {
        const data = await callApi("/api/web/handoff", {
          widgetKey      : cfg.widgetKey,
          ...(sessionId.current ? { conversationId: sessionId.current } : {}),
        });
        if (data.whatsapp_link) {
          window.open(data.whatsapp_link, "_blank", "noopener,noreferrer");
        } else {
          setMessages(m => [...m, {
            role: "agent", type: "text",
            text: "I've let the team know — someone will be in touch with you shortly.",
          }]);
        }
      } catch {
        setMessages(m => [...m, {
          role: "agent", type: "text",
          text: "Unable to reach the team right now. Contact the pharmacy directly.",
        }]);
      }
    },
    [cfg.widgetKey, callApi],
  );

  // ── Init: fetch greeting on mount ─────────────────────────────────────────
  // Sends "Hi" so the server returns the welcome message (personalised if the
  // user is logged in via Supabase). Strips the numbered menu from the reply
  // since the component renders its own interactive menu buttons.
  // Falls back to a static greeting if the API is not configured. The fallback
  // intro is marked rather than baked in as text, so it picks up the tenant's
  // agentDisplayName even if widget-config resolves after this effect.
  useEffect(() => {
    if (!cfg.widgetKey || !cfg.apiUrl) {
      setMessages([
        { role: "agent", type: "intro", fallbackIntro: true },
        { role: "agent", type: "menu" },
      ]);
      return;
    }

    let live = true;
    (async () => {
      try {
        const token = await getToken();
        const form  = new FormData();
        form.append("widgetKey", cfg.widgetKey);
        if (sessionId.current) form.append("conversationId", sessionId.current);
        if (token)             form.append("identityToken",  token);
        form.append("text", "Hi");

        const data = await callApi("/api/web/message", form);
        if (!live) return;

        if (data.conversationId) {
          sessionId.current = data.conversationId;
          try { sessionStorage.setItem(SESSION_PREFIX + cfg.widgetKey, data.conversationId); } catch {}
        }

        // Strip the numbered menu text — the component renders its own menu UI
        const greeting = (data.reply || "").replace(/\n+\d+\.\s.*/g, "").trim();

        setMessages([
          { role: "agent", type: "intro", text: greeting },
          { role: "agent", type: "menu" },
        ]);
      } catch {
        if (!live) return;
        setMessages([
          { role: "agent", type: "intro", fallbackIntro: true },
          { role: "agent", type: "menu" },
        ]);
      }
    })();

    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — mount-only

  // ── pushAndReply ──────────────────────────────────────────────────────────
  const pushAndReply = useCallback(
    async ({ text, file, intent, displayText }) => {
      setMessages(m => [...m, {
        role: "user", type: file ? "file" : "text",
        text: displayText ?? text,
        fileName: file?.name,
      }]);
      setSending(true);
      try {
        const reply = await sendToZero({ text, file, intent });
        setMessages(m => [...m, { role: "agent", type: "text", text: reply }]);
      } catch (err) {
        setMessages(m => [...m, {
          role: "agent", type: "text",
          text: err?.status === 403
            ? "This pharmacy is not currently taking orders."
            : "That didn't go through. Check your connection and send it again.",
        }]);
      } finally {
        setSending(false);
      }
    },
    [sendToZero],
  );

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleMenu = (item) => {
    setMenuUsed(true);
    pushAndReply({ text: item.label, intent: item.id, displayText: item.label });
  };

  const handleSend = () => {
    const text = draft.trim();
    if (!text && !attach) return;
    const file = attach;
    setDraft("");
    setAttach(null);
    pushAndReply({ text: text || "(attachment)", file, displayText: text || `Sent ${file?.name}` });
    inputRef.current?.focus();
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const onPickFile = (e) => {
    const f = e.target.files?.[0];
    if (f) setAttach(f);
    e.target.value = "";
  };

  // ── Brand mark: tenant logo when configured, Zero mark otherwise ──────────
  const brandMark = (size) =>
    brand.logoUrl
      ? <img src={brand.logoUrl} alt="" aria-hidden width={size} height={size}
             style={{ width: size, height: size, borderRadius: "28%", objectFit: "cover", display: "block" }} />
      : <ZeroMark size={size} t={T} />;

  // ── Launcher (collapsed) ──────────────────────────────────────────────────
  if (!open) {
    return (
      <div style={S.root}>
        <style>{KEYFRAMES}</style>
        <button aria-label={`Chat with ${agentName}`} onClick={() => setOpen(true)} style={S.launcher}>
          {brandMark(26)}
        </button>
      </div>
    );
  }

  const panelStyle = {
    ...S.panel,
    width : expanded ? "min(440px, calc(100vw - 32px))" : "min(380px, calc(100vw - 32px))",
    height: expanded ? "min(680px, calc(100vh - 32px))" : "min(560px, calc(100vh - 32px))",
  };

  return (
    <div style={S.root}>
      <style>{KEYFRAMES}</style>
      <div style={panelStyle} role="dialog" aria-label={`Chat with ${agentName}, ${pharmacyName}`}>

        {/* Header */}
        <div style={S.header}>
          <div style={S.headerLeft}>
            <div style={S.avatar}>
              {brandMark(20)}
              <span style={S.presence} />
            </div>
            <div>
              <div style={S.headerName}>{agentName}</div>
              <div style={S.headerSub}>{pharmacyName}</div>
            </div>
          </div>
          <div style={S.headerActions}>
            <IconBtn label="Talk to a person" onClick={() => requestHumanAgent()} S={S} T={T}>
              <Headset size={18} />
            </IconBtn>
            <IconBtn
              label={expanded ? "Shrink" : "Expand"}
              onClick={() => setExpanded(v => !v)}
              S={S} T={T}
            >
              {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            </IconBtn>
            <IconBtn label="Minimize" onClick={() => setOpen(false)} S={S} T={T}>
              <Minus size={18} />
            </IconBtn>
          </div>
        </div>

        {/* Privacy notice */}
        <div style={S.notice}>
          Chat history is stored. Please don&apos;t share sensitive personal information.
        </div>

        {/* Messages */}
        <div style={S.scroll} ref={scrollRef}>
          {messages.map((m, i) => {
            if (m.type === "menu") {
              return (
                <div key={i} style={S.bubbleAgentWrap}>
                  <div style={{ ...S.bubble, ...S.bubbleAgent, maxWidth: "94%" }}>
                    <div style={S.menuTitle}>How can I help?</div>
                    <div style={S.menuList}>
                      {MENU_ITEMS.map(item => (
                        <button
                          key={item.id}
                          style={S.menuItem}
                          disabled={menuUsed}
                          onClick={() => handleMenu(item)}
                          onMouseEnter={e => !menuUsed && (e.currentTarget.style.background = T.tintHover)}
                          onMouseLeave={e => (e.currentTarget.style.background = T.tint)}
                        >
                          <span style={S.menuIcon}><item.Icon size={17} /></span>
                          <span style={S.menuText}>
                            <span style={S.menuLabel}>{item.label}</span>
                            <span style={S.menuSub}>{item.sub}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            }

            const isUser = m.role === "user";
            const text   = m.fallbackIntro
              ? `Hi, I'm ${agentName}, your AI agent for ${pharmacyName}.`
              : (m.text || "").replace(/\*/g, ""); // strip markdown bold markers
            return (
              <div key={i} style={isUser ? S.bubbleUserWrap : S.bubbleAgentWrap}>
                <div style={{ ...S.bubble, ...(isUser ? S.bubbleUser : S.bubbleAgent) }}>
                  {m.type === "file" && (
                    <span style={S.fileChip}>
                      <Paperclip size={13} />
                      {m.fileName ?? "Attachment"}
                    </span>
                  )}
                  {text}
                </div>
              </div>
            );
          })}

          {sending && (
            <div style={S.bubbleAgentWrap}>
              <div style={{ ...S.bubble, ...S.bubbleAgent, ...S.typing }}>
                <span style={{ ...S.dot, animationDelay: "0ms"   }} />
                <span style={{ ...S.dot, animationDelay: "160ms" }} />
                <span style={{ ...S.dot, animationDelay: "320ms" }} />
              </div>
            </div>
          )}
        </div>

        {/* Attachment preview */}
        {attach && (
          <div style={S.attachBar}>
            <span style={S.attachInfo}>
              <Paperclip size={14} />
              <span style={S.attachName}>{attach.name}</span>
            </span>
            <button style={S.attachX} aria-label="Remove attachment" onClick={() => setAttach(null)}>
              <X size={15} />
            </button>
          </div>
        )}

        {/* Composer */}
        <div style={S.composer}>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            style={{ display: "none" }}
            onChange={onPickFile}
          />
          <IconBtn
            label="Attach prescription or image"
            onClick={() => fileRef.current?.click()}
            tone="muted"
            S={S} T={T}
          >
            <Paperclip size={19} />
          </IconBtn>
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={handleKey}
            placeholder={`Message ${agentName}…`}
            style={S.input}
          />
          <button
            aria-label="Send"
            onClick={handleSend}
            disabled={!draft.trim() && !attach}
            style={{
              ...S.sendBtn,
              opacity: !draft.trim() && !attach ? 0.4 : 1,
              cursor : !draft.trim() && !attach ? "default" : "pointer",
            }}
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Brand mark (default — replaced by theme.logoUrl when configured) ──────────
function ZeroMark({ size = 24, t = DEFAULT_TOKENS }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect width="32" height="32" rx="9" fill={t.ink} />
      <path
        d="M11 11h10l-9.5 10H21"
        stroke={t.accent}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconBtn({ children, label, onClick, tone, S, T }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...S.iconBtn,
        color     : tone === "muted" ? T.sub : T.inkSoft,
        background: hover ? T.tint : "transparent",
      }}
    >
      {children}
    </button>
  );
}

// ── Style factory ─────────────────────────────────────────────────────────────
// Built from the state-held tokens so per-tenant themes restyle everything.
function makeStyles(T, font) {
  return {
    root: {
      position  : "fixed",
      right     : 16,
      bottom    : 16,
      zIndex    : 2147483000,
      fontFamily: font,
    },
    launcher: {
      width       : 58,
      height      : 58,
      borderRadius: "50%",
      border      : "none",
      background  : T.surface,
      boxShadow   : "0 8px 30px rgba(15,27,45,0.22)",
      display     : "grid",
      placeItems  : "center",
      cursor      : "pointer",
      transition  : "transform 140ms ease",
    },
    panel: {
      display       : "flex",
      flexDirection : "column",
      background    : T.surface,
      borderRadius  : 18,
      border        : `1px solid ${T.line}`,
      boxShadow     : "0 18px 60px rgba(15,27,45,0.26)",
      overflow      : "hidden",
      animation     : "zeroIn 180ms cubic-bezier(.2,.7,.3,1)",
    },
    header: {
      display        : "flex",
      alignItems     : "center",
      justifyContent : "space-between",
      padding        : "12px 12px 12px 14px",
      borderBottom   : `1px solid ${T.line}`,
      background     : T.surface,
    },
    headerLeft   : { display: "flex", alignItems: "center", gap: 10 },
    avatar       : { position: "relative", width: 34, height: 34, display: "grid", placeItems: "center" },
    presence     : {
      position    : "absolute",
      right       : -1,
      bottom      : -1,
      width       : 10,
      height      : 10,
      borderRadius: "50%",
      background  : T.accent,
      border      : `2px solid ${T.surface}`,
    },
    headerName   : { fontSize: 15, fontWeight: 650, color: T.ink, lineHeight: 1.1 },
    headerSub    : { fontSize: 12, color: T.sub, marginTop: 2 },
    headerActions: { display: "flex", alignItems: "center", gap: 2 },
    iconBtn: {
      width       : 32,
      height      : 32,
      border      : "none",
      borderRadius: 9,
      display     : "grid",
      placeItems  : "center",
      cursor      : "pointer",
      transition  : "background 120ms ease",
    },
    notice: {
      fontSize    : 11.5,
      lineHeight  : 1.4,
      color       : T.sub,
      textAlign   : "center",
      padding     : "9px 18px",
      background  : T.canvas,
      borderBottom: `1px solid ${T.line}`,
    },
    scroll: {
      flex         : 1,
      overflowY    : "auto",
      padding      : "16px 14px",
      background   : T.canvas,
      display      : "flex",
      flexDirection: "column",
      gap          : 8,
    },
    bubbleAgentWrap: { display: "flex", justifyContent: "flex-start"  },
    bubbleUserWrap : { display: "flex", justifyContent: "flex-end"    },
    bubble: {
      maxWidth  : "78%",
      padding   : "12px 16px",
      fontSize  : 14.5,
      lineHeight: 1.5,
      borderRadius: 16,
      whiteSpace: "pre-wrap",
      wordBreak : "break-word",
    },
    bubbleAgent: {
      background          : T.surface,
      color               : T.ink,
      border              : `1px solid ${T.line}`,
      borderBottomLeftRadius: 5,
    },
    bubbleUser: {
      background             : T.userBubble,
      color                  : "#fff",
      borderBottomRightRadius: 5,
    },
    menuTitle: { fontSize: 14.5, fontWeight: 600, color: T.ink, marginBottom: 11 },
    menuList : { display: "flex", flexDirection: "column", gap: 10 },
    menuItem : {
      display    : "flex",
      alignItems : "center",
      gap        : 12,
      width      : "100%",
      textAlign  : "left",
      padding    : "14px 16px",
      borderRadius: 11,
      border     : `1px solid ${T.line}`,
      background : T.tint,
      cursor     : "pointer",
      transition : "background 120ms ease",
    },
    menuIcon: {
      width       : 30,
      height      : 30,
      borderRadius: 8,
      display     : "grid",
      placeItems  : "center",
      background  : T.surface,
      color       : T.accent,
      border      : `1px solid ${T.line}`,
      flexShrink  : 0,
    },
    menuText : { display: "flex", flexDirection: "column", gap: 4 },
    menuLabel: { fontSize: 14, fontWeight: 600, lineHeight: 1.3, color: T.ink },
    menuSub  : { fontSize: 12, lineHeight: 1.3, color: T.sub },
    fileChip : {
      display    : "inline-flex",
      alignItems : "center",
      gap        : 5,
      fontSize   : 12.5,
      fontWeight : 500,
      padding    : "3px 8px",
      borderRadius: 8,
      background : "rgba(255,255,255,0.16)",
      marginBottom: 6,
    },
    typing: { display: "inline-flex", gap: 4, alignItems: "center", padding: "13px 14px" },
    dot   : {
      width       : 7,
      height      : 7,
      borderRadius: "50%",
      background  : T.sub,
      display     : "inline-block",
      animation   : "zeroBlink 1s infinite ease-in-out",
    },
    attachBar : {
      display        : "flex",
      alignItems     : "center",
      justifyContent : "space-between",
      gap            : 8,
      padding        : "8px 12px",
      borderTop      : `1px solid ${T.line}`,
      background     : T.surface,
    },
    attachInfo: { display: "flex", alignItems: "center", gap: 7, color: T.inkSoft, minWidth: 0 },
    attachName: { fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
    attachX   : {
      border      : "none",
      background  : T.tint,
      borderRadius: 7,
      width       : 26,
      height      : 26,
      display     : "grid",
      placeItems  : "center",
      cursor      : "pointer",
      color       : T.sub,
      flexShrink  : 0,
    },
    composer: {
      display    : "flex",
      alignItems : "flex-end",
      gap        : 6,
      padding    : 10,
      borderTop  : `1px solid ${T.line}`,
      background : T.surface,
    },
    input: {
      flex      : 1,
      resize    : "none",
      border    : "none",
      outline   : "none",
      fontFamily: font,
      fontSize  : 14.5,
      lineHeight: 1.4,
      color     : T.ink,
      background: "transparent",
      maxHeight : 120,
      padding   : "8px 4px",
    },
    sendBtn: {
      width       : 38,
      height      : 38,
      borderRadius: 11,
      border      : "none",
      background  : T.accent,
      color       : T.accentInk,
      display     : "grid",
      placeItems  : "center",
      flexShrink  : 0,
      transition  : "opacity 120ms ease",
    },
  };
}

const KEYFRAMES = `
@keyframes zeroIn    { from { opacity:0; transform:translateY(12px) scale(.98); } to { opacity:1; transform:none; } }
@keyframes zeroBlink { 0%,80%,100% { opacity:.3; transform:translateY(0); } 40% { opacity:1; transform:translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { *{ animation:none !important; transition:none !important; } }
`;
