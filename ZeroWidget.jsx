'use client';

import { useState, useRef, useEffect, useCallback } from "react";
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
 * supabaseClient object   optional  — @supabase/supabase-js client
 *                                     When provided, the current user's JWT is
 *                                     attached so Zero can personalise the greeting
 *                                     and offer reorders for logged-in users.
 *                                     Omit for guest-only sites.
 *
 * Network contract (all traffic through one function)
 * ────────────────────────────────────────────────────
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

export default function ZeroWidget(props) {
  const cfg = { ...DEFAULTS, ...props };

  const [open,     setOpen]     = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState([]);   // populated by init effect
  const [draft,    setDraft]    = useState("");
  const [attach,   setAttach]   = useState(null);
  const [sending,  setSending]  = useState(false);
  const [menuUsed, setMenuUsed] = useState(false);

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
  // Falls back to a static greeting if the API is not configured.
  useEffect(() => {
    if (!cfg.widgetKey || !cfg.apiUrl) {
      setMessages([
        { role: "agent", type: "intro", text: `Hi, I'm Zero, your AI agent for ${cfg.pharmacyName}.` },
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
          { role: "agent", type: "intro", text: `Hi, I'm Zero, your AI agent for ${cfg.pharmacyName}.` },
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

  // ── Launcher (collapsed) ──────────────────────────────────────────────────
  if (!open) {
    return (
      <div style={S.root}>
        <style>{KEYFRAMES}</style>
        <button aria-label="Chat with Zero" onClick={() => setOpen(true)} style={S.launcher}>
          <ZeroMark size={26} />
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
      <div style={panelStyle} role="dialog" aria-label={`Chat with Zero, ${cfg.pharmacyName}`}>

        {/* Header */}
        <div style={S.header}>
          <div style={S.headerLeft}>
            <div style={S.avatar}>
              <ZeroMark size={20} />
              <span style={S.presence} />
            </div>
            <div>
              <div style={S.headerName}>Zero</div>
              <div style={S.headerSub}>{cfg.pharmacyName}</div>
            </div>
          </div>
          <div style={S.headerActions}>
            <IconBtn label="Talk to a person" onClick={() => requestHumanAgent()}>
              <Headset size={18} />
            </IconBtn>
            <IconBtn
              label={expanded ? "Shrink" : "Expand"}
              onClick={() => setExpanded(v => !v)}
            >
              {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            </IconBtn>
            <IconBtn label="Minimize" onClick={() => setOpen(false)}>
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
                  <div style={{ ...S.bubble, ...S.bubbleAgent }}>
                    <div style={S.menuTitle}>How can I help?</div>
                    <div style={S.menuList}>
                      {MENU_ITEMS.map(item => (
                        <button
                          key={item.id}
                          style={S.menuItem}
                          disabled={menuUsed}
                          onClick={() => handleMenu(item)}
                          onMouseEnter={e => !menuUsed && (e.currentTarget.style.background = TOKENS.tintHover)}
                          onMouseLeave={e => (e.currentTarget.style.background = TOKENS.tint)}
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
            return (
              <div key={i} style={isUser ? S.bubbleUserWrap : S.bubbleAgentWrap}>
                <div style={{ ...S.bubble, ...(isUser ? S.bubbleUser : S.bubbleAgent) }}>
                  {m.type === "file" && (
                    <span style={S.fileChip}>
                      <Paperclip size={13} />
                      {m.fileName ?? "Attachment"}
                    </span>
                  )}
                  {m.text}
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
          >
            <Paperclip size={19} />
          </IconBtn>
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Message Zero…"
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

// ── Brand mark ────────────────────────────────────────────────────────────────
function ZeroMark({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect width="32" height="32" rx="9" fill={TOKENS.ink} />
      <path
        d="M11 11h10l-9.5 10H21"
        stroke={TOKENS.accent}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconBtn({ children, label, onClick, tone }) {
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
        color     : tone === "muted" ? TOKENS.sub : TOKENS.inkSoft,
        background: hover ? TOKENS.tint : "transparent",
      }}
    >
      {children}
    </button>
  );
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const TOKENS = {
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

const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';

const S = {
  root: {
    position  : "fixed",
    right     : 16,
    bottom    : 16,
    zIndex    : 2147483000,
    fontFamily: FONT,
  },
  launcher: {
    width       : 58,
    height      : 58,
    borderRadius: "50%",
    border      : "none",
    background  : TOKENS.surface,
    boxShadow   : "0 8px 30px rgba(15,27,45,0.22)",
    display     : "grid",
    placeItems  : "center",
    cursor      : "pointer",
    transition  : "transform 140ms ease",
  },
  panel: {
    display       : "flex",
    flexDirection : "column",
    background    : TOKENS.surface,
    borderRadius  : 18,
    border        : `1px solid ${TOKENS.line}`,
    boxShadow     : "0 18px 60px rgba(15,27,45,0.26)",
    overflow      : "hidden",
    animation     : "zeroIn 180ms cubic-bezier(.2,.7,.3,1)",
  },
  header: {
    display        : "flex",
    alignItems     : "center",
    justifyContent : "space-between",
    padding        : "12px 12px 12px 14px",
    borderBottom   : `1px solid ${TOKENS.line}`,
    background     : TOKENS.surface,
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
    background  : TOKENS.accent,
    border      : `2px solid ${TOKENS.surface}`,
  },
  headerName   : { fontSize: 15, fontWeight: 650, color: TOKENS.ink, lineHeight: 1.1 },
  headerSub    : { fontSize: 12, color: TOKENS.sub, marginTop: 2 },
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
    color       : TOKENS.sub,
    textAlign   : "center",
    padding     : "9px 18px",
    background  : TOKENS.canvas,
    borderBottom: `1px solid ${TOKENS.line}`,
  },
  scroll: {
    flex         : 1,
    overflowY    : "auto",
    padding      : "16px 14px",
    background   : TOKENS.canvas,
    display      : "flex",
    flexDirection: "column",
    gap          : 8,
  },
  bubbleAgentWrap: { display: "flex", justifyContent: "flex-start"  },
  bubbleUserWrap : { display: "flex", justifyContent: "flex-end"    },
  bubble: {
    maxWidth  : "82%",
    padding   : "10px 13px",
    fontSize  : 14.5,
    lineHeight: 1.45,
    borderRadius: 16,
    whiteSpace: "pre-wrap",
    wordBreak : "break-word",
  },
  bubbleAgent: {
    background          : TOKENS.surface,
    color               : TOKENS.ink,
    border              : `1px solid ${TOKENS.line}`,
    borderBottomLeftRadius: 5,
  },
  bubbleUser: {
    background             : TOKENS.userBubble,
    color                  : "#fff",
    borderBottomRightRadius: 5,
  },
  menuTitle: { fontSize: 14.5, fontWeight: 600, color: TOKENS.ink, marginBottom: 9 },
  menuList : { display: "flex", flexDirection: "column", gap: 7 },
  menuItem : {
    display    : "flex",
    alignItems : "center",
    gap        : 11,
    width      : "100%",
    textAlign  : "left",
    padding    : "9px 11px",
    borderRadius: 11,
    border     : `1px solid ${TOKENS.line}`,
    background : TOKENS.tint,
    cursor     : "pointer",
    transition : "background 120ms ease",
  },
  menuIcon: {
    width       : 30,
    height      : 30,
    borderRadius: 8,
    display     : "grid",
    placeItems  : "center",
    background  : TOKENS.surface,
    color       : TOKENS.accent,
    border      : `1px solid ${TOKENS.line}`,
    flexShrink  : 0,
  },
  menuText : { display: "flex", flexDirection: "column", gap: 1 },
  menuLabel: { fontSize: 14, fontWeight: 550, color: TOKENS.ink },
  menuSub  : { fontSize: 12, color: TOKENS.sub },
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
    background  : TOKENS.sub,
    display     : "inline-block",
    animation   : "zeroBlink 1s infinite ease-in-out",
  },
  attachBar : {
    display        : "flex",
    alignItems     : "center",
    justifyContent : "space-between",
    gap            : 8,
    padding        : "8px 12px",
    borderTop      : `1px solid ${TOKENS.line}`,
    background     : TOKENS.surface,
  },
  attachInfo: { display: "flex", alignItems: "center", gap: 7, color: TOKENS.inkSoft, minWidth: 0 },
  attachName: { fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  attachX   : {
    border      : "none",
    background  : TOKENS.tint,
    borderRadius: 7,
    width       : 26,
    height      : 26,
    display     : "grid",
    placeItems  : "center",
    cursor      : "pointer",
    color       : TOKENS.sub,
    flexShrink  : 0,
  },
  composer: {
    display    : "flex",
    alignItems : "flex-end",
    gap        : 6,
    padding    : 10,
    borderTop  : `1px solid ${TOKENS.line}`,
    background : TOKENS.surface,
  },
  input: {
    flex      : 1,
    resize    : "none",
    border    : "none",
    outline   : "none",
    fontFamily: FONT,
    fontSize  : 14.5,
    lineHeight: 1.4,
    color     : TOKENS.ink,
    background: "transparent",
    maxHeight : 120,
    padding   : "8px 4px",
  },
  sendBtn: {
    width       : 38,
    height      : 38,
    borderRadius: 11,
    border      : "none",
    background  : TOKENS.accent,
    color       : TOKENS.accentInk,
    display     : "grid",
    placeItems  : "center",
    flexShrink  : 0,
    transition  : "opacity 120ms ease",
  },
};

const KEYFRAMES = `
@keyframes zeroIn    { from { opacity:0; transform:translateY(12px) scale(.98); } to { opacity:1; transform:none; } }
@keyframes zeroBlink { 0%,80%,100% { opacity:.3; transform:translateY(0); } 40% { opacity:1; transform:translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { *{ animation:none !important; transition:none !important; } }
`;
