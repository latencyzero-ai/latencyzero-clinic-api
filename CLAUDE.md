# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Start the server
node index.js

# No lint or test commands are configured
```

The entire backend lives in `index.js`. There is no build step.

## Required Environment Variables

Create a `.env` file (excluded from git) with:

```
DATABASE_URL=          # PostgreSQL connection string (SSL required, rejectUnauthorized: false)
GEMINI_API_KEY=        # Google Gemini API key (replaces Groq)
META_PHONE_NUMBER_ID=  # Meta WhatsApp Business phone number ID
META_ACCESS_TOKEN=     # Meta Graph API access token
META_VERIFY_TOKEN=     # Webhook verification token for Meta
ADMIN_TOKEN=           # Bearer token for /api/admin/* routes (default: lz-admin-change-this)
PORT=                  # Optional, defaults to 3001
DASHBOARD_URL=         # Dashboard URL for receptionist notifications (default: https://zero-dashboard-nine.vercel.app)
```

## Architecture

Single-file Express + Socket.io backend (`index.js`). No modules, no routing files.

### Database (PostgreSQL via `pg` Pool)

Four tables — none are created by this repo; they must exist in the connected database:

| Table | Purpose |
|---|---|
| `conversations` | Per-phone state machine: `phone`, `state` (START/MENU/ACTIVE/DONE), `data` (JSONB storing history + collected fields) |
| `patients` | Walk-in registrations with queue number, department, urgency, status |
| `appointments` | Scheduled appointments |
| `queue` | Daily counter for queue numbers (one row per date) |
| `clinic_config` | Single-row config: clinic name, agent name, receptionist/doctor WhatsApp, services array |

Conversation history is stored as a JSONB array inside `conversations.data.history` — there is no separate messages table. History is capped at 20 entries when writing to `ACTIVE` state and 50 entries when writing to `DONE`.

### AI Pipeline

Two sequential Groq calls per completed intake:

1. **`zeroAI()`** — `llama-3.3-70b-versatile` with JSON mode. Drives the conversational intake: extracts patient fields from natural language, returns `{reply, extracted, is_complete, intent}`. System prompt hardcodes field collection order and medical domain follow-up logic. History is stripped to `{role, content}` before sending (timestamps are local only).

2. **`getAIRouting()`** — `llama-3.1-8b-instant`. Classifies the complaint into department + urgency + one-line summary. Only called when intake is complete.

### Conversation State Machine

```
START → MENU → ACTIVE → DONE
         ↑                |
         └────────────────┘  (patient messages again after DONE)
```

`processMessage()` dispatches on `conv.state`. The `ACTIVE` state calls `zeroAI()` and accumulates fields into `data`. When `is_complete` is true, the server validates required fields, calls `getAIRouting()`, saves to `patients` or `appointments`, and transitions to `DONE`.

Idempotency: incoming webhook message IDs are tracked in a 60-second in-memory TTL map to prevent duplicate processing.

### Real-time (Socket.io)

Dashboard clients connect via Socket.io. Events emitted:
- `new_message` — both directions on every WhatsApp exchange
- `queue_updated` — on any queue/patient state change
- `conversation_updated` — on flag resolve
- `ai_paused` — when AI is paused for a conversation

### API Surface

| Prefix | Auth | Purpose |
|---|---|---|
| `GET /webhook/whatsapp` | none | Meta webhook verification |
| `POST /webhook/whatsapp` | none | Incoming Meta WhatsApp messages |
| `POST /webhook/twilio` | none | Twilio sandbox testing |
| `GET/POST/PATCH /api/conversations*` | none | Dashboard conversation viewer + manual reply |
| `GET /api/patients*`, `/api/queue*`, `/api/appointments` | none | Dashboard queue management |
| `PATCH /api/patients/:id/status` | none | Update patient status |
| `POST /api/queue/next` | none | Call next patient (sends WhatsApp) |
| `GET /api/stats/today` | none | Today's dashboard stats |
| `GET /api/admin/*` | `x-admin-token` header | Health, overview, conversation management, clinic config, manual messaging, logs |
| `GET /api/metrics/*` | `x-admin-token` header | Impact metrics and Zero performance stats |

### Background Jobs

`setInterval` fires every 5 minutes to check `appointments` with status `scheduled` and `appointment_time` within the next 30 minutes, sends a WhatsApp reminder, and updates status to `reminder_sent`.

### Notification Flow

On registration/appointment/queue events, `notifyClinic()` sends a formatted WhatsApp message to `config.receptionist_whatsapp` (if set) and emits `queue_updated` over Socket.io.

## Key Constraints

- The webhook responds `200` immediately before processing to satisfy Meta's 20-second timeout requirement.
- The appointment reminder time comparison uses raw time strings (`HH:MM:SS`) — timezone-sensitive.
- `clinic_config` expects exactly one row with `id = 1` for admin updates.
- The `PATCH /api/admin/clinic` endpoint only allows updating: `clinic_name`, `agent_name`, `receptionist_whatsapp`, `doctor_whatsapp`, `services`.
