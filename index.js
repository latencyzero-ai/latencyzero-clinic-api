require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const { Pool } = require('pg');
// const { GoogleGenerativeAI } = require('@google/generative-ai');

// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const crypto = require('crypto');

const multer = require('multer');
const { loadAdapter } = require('./adapters');
const { createPharmacyProcessor } = require('./pharmacyFlow');

const app = express();
app.use(cors({ origin: '*' }));
// Capture raw body on every JSON request — needed by /webhook/payment for HMAC verification
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true }));

// ─── HTTP + SOCKET.IO SERVER ──────────────────────────
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

io.on('connection', (socket) => {
  console.log('Dashboard connected:', socket.id);
  socket.on('disconnect', () => console.log('Dashboard disconnected:', socket.id));
});

// ─── DATABASE ─────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── IN-MEMORY ERROR LOG (last 100 entries) ───────────
const errorLog = [];
function addLog(level, message, data = null) {
  const entry = { level, message, data: data ? String(data) : null, timestamp: new Date().toISOString() };
  errorLog.unshift(entry);
  if (errorLog.length > 100) errorLog.pop();
  if (level === 'error') console.error(`[${level.toUpperCase()}]`, message, data || '');
  else console.log(`[${level.toUpperCase()}]`, message, data || '');
}

// ─── IDEMPOTENCY GUARD ────────────────────────────────
const processedMessages = new Map();
function isAlreadyProcessed(messageId) {
  const now = Date.now();
  for (const [id, ts] of processedMessages) {
    if (now - ts > 60000) processedMessages.delete(id);
  }
  if (processedMessages.has(messageId)) return true;
  processedMessages.set(messageId, now);
  return false;
}

// ─── ADMIN AUTH MIDDLEWARE ────────────────────────────
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'lz-admin-change-this';
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== ADMIN_TOKEN) {
    addLog('warn', 'Unauthorized admin access attempt', req.ip);
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── META WHATSAPP CONFIG ─────────────────────────────
const META_API = 'https://graph.facebook.com/v21.0';
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://zero-dashboard-nine.vercel.app';

// ─── TIME GREETING ─────────────────────────────────────
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// ─── PHARMACY FLOW ENGINE ─────────────────────────────
// Instantiated once; adapter is loaded per-request inside the webhook.
const pharmFlow = createPharmacyProcessor({
  pool,
  groq,
  io,
  addLog,
  sendWhatsApp,
  getGreeting,
  META_API,
  ACCESS_TOKEN,
});

// ─── GET CLINIC CONFIG ────────────────────────────────
async function getConfig() {
  const result = await pool.query('SELECT * FROM clinic_config LIMIT 1');
  const config = result.rows[0] || { clinic_name: 'Our Clinic', agent_name: 'Zero' };
  if (!config.services || !Array.isArray(config.services)) {
    config.services = ['General Consultation', 'Dental Care', 'Cardiology', 'Neurology', 'Laboratory Tests'];
  }
  return config;
}

// ─── GET CONVERSATION ─────────────────────────────────
async function getConversation(phone) {
  const result = await pool.query('SELECT * FROM conversations WHERE phone = $1', [phone]);
  if (result.rows.length === 0) {
    await pool.query(
      'INSERT INTO conversations (phone, state, data) VALUES ($1, $2, $3)',
      [phone, 'START', '{}']
    );
    return { phone, state: 'START', data: {}, history: [] };
  }
  const row = result.rows[0];
  return { ...row, data: row.data || {}, history: row.data?.history || [] };
}

// ─── UPDATE CONVERSATION ──────────────────────────────
async function updateConversation(phone, state, data) {
  await pool.query(
    `INSERT INTO conversations (phone, state, data, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (phone) DO UPDATE
     SET state = $2, data = $3, updated_at = NOW()`,
    [phone, state, JSON.stringify(data)]
  );
}

// ─── PHARMACY CONVERSATION HELPERS ────────────────────
// Uses the separate pharmacy_conversations table so clinic and
// pharmacy state machines never share rows for the same phone.
async function getPharmacyConversation(phone, pharmacyId) {
  const result = await pool.query(
    'SELECT * FROM pharmacy_conversations WHERE phone = $1 AND pharmacy_id = $2',
    [phone, pharmacyId]
  );
  if (result.rows.length === 0) {
    const inserted = await pool.query(
      `INSERT INTO pharmacy_conversations (pharmacy_id, phone, state, data)
       VALUES ($1, $2, 'START', $3) RETURNING *`,
      [pharmacyId, phone, JSON.stringify({ cart: [] })]
    );
    return { ...inserted.rows[0], data: { cart: [] } };
  }
  const row = result.rows[0];
  return { ...row, data: row.data || { cart: [] } };
}

async function updatePharmacyConversation(phone, pharmacyId, state, data) {
  await pool.query(
    `INSERT INTO pharmacy_conversations (pharmacy_id, phone, state, data, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (pharmacy_id, phone) DO UPDATE
     SET state = $3, data = $4, updated_at = NOW()`,
    [pharmacyId, phone, state, JSON.stringify(data)]
  );
}

// ─── GET NEXT QUEUE NUMBER ────────────────────────────
async function getNextQueueNumber() {
  const today = new Date().toISOString().split('T')[0];
  const existing = await pool.query('SELECT * FROM queue WHERE date = $1', [today]);
  if (existing.rows.length === 0) {
    await pool.query('INSERT INTO queue (date, last_number) VALUES ($1, 1)', [today]);
    return 1;
  }
  const next = existing.rows[0].last_number + 1;
  await pool.query('UPDATE queue SET last_number = $1 WHERE date = $2', [next, today]);
  return next;
}

// ─── SEND WHATSAPP VIA META ───────────────────────────
async function sendWhatsApp(to, message, phoneNumberId = PHONE_NUMBER_ID) {
  try {
    const cleanPhone = to.replace(/[^0-9]/g, '');
    await axios.post(
      `${META_API}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'text',
        text: { body: message }
      },
      {
        headers: {
          'Authorization': `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    addLog('info', `WhatsApp sent to ${cleanPhone}`);
  } catch (e) {
    addLog('error', 'WhatsApp send error', e.response?.data || e.message);
  }
}

// ─── TENANT RESOLUTION ────────────────────────────────
// Looks up the incoming phone_number_id in pharmacy_config.
// Returns PHARMACY (active), PHARMACY_INACTIVE (kill switch engaged),
// or CLINIC (no pharmacy row — fall through to clinic flow).
// Kill switch: set pharmacy_config.active = false in the DB;
// Zero stops responding for that tenant on the very next message.
async function resolveTenant(phoneNumberId) {
  if (!phoneNumberId) return { business_type: 'CLINIC', config: null };
  try {
    const result = await pool.query(
      'SELECT * FROM pharmacy_config WHERE phone_number_id = $1 LIMIT 1',
      [phoneNumberId]
    );
    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        business_type: row.active ? 'PHARMACY' : 'PHARMACY_INACTIVE',
        config: row,
      };
    }
  } catch (e) {
    addLog('error', 'Tenant resolution error', e.message);
  }
  return { business_type: 'CLINIC', config: null };
}

// ─── NOTIFY CLINIC ────────────────────────────────────
async function notifyClinic(type, data, config) {
  const urgencyEmoji = { 'High': '🔴', 'Medium': '🟡', 'Low': '🟢' };
  let clinicMsg = '';

  if (type === 'walkin') {
    clinicMsg =
      `🔔 *New Walk-in Patient*\n\n` +
      `Queue: *#${data.queueNumber}*\n` +
      `Name: *${data.name}*\n` +
      `Age: ${data.age} | ${data.gender}\n` +
      `Phone: ${data.phone}\n` +
      `Department: *${data.department}*\n` +
      `${urgencyEmoji[data.urgency] || '🟢'} Urgency: *${data.urgency}*\n\n` +
      `Complaint: ${data.complaint}\n` +
      `Symptoms: ${data.symptoms}\n` +
      `Summary: ${data.summary}\n\n` +
      `Dashboard: ${DASHBOARD_URL}`;
  }

  if (type === 'onmyway') {
    clinicMsg =
      `🔔 *Patient On The Way*\n\n` +
      `Name: *${data.name}*\n` +
      `Age: ${data.age} | ${data.gender}\n` +
      `Phone: ${data.phone}\n` +
      `Likely Department: *${data.department}*\n` +
      `${urgencyEmoji[data.urgency] || '🟢'} Urgency: *${data.urgency}*\n\n` +
      `Complaint: ${data.complaint}\n` +
      `Summary: ${data.summary}\n\n` +
      `_Queue number will be assigned on arrival._\n\n` +
      `Dashboard: ${DASHBOARD_URL}`;
  }

  if (type === 'appointment') {
    clinicMsg =
      `📅 *New Appointment Scheduled*\n\n` +
      `Name: *${data.name}*\n` +
      `Age: ${data.age} | ${data.gender}\n` +
      `Phone: ${data.phone}\n` +
      `Department: *${data.department}*\n` +
      `Date: *${data.appointment_date}*\n` +
      `Time: *${data.appointment_time}*\n\n` +
      `Complaint: ${data.complaint}\n\n` +
      `Dashboard: ${DASHBOARD_URL}`;
  }

  if (type === 'next') {
    clinicMsg =
      `✅ *Next Patient Ready*\n\n` +
      `Queue: *#${data.queueNumber}*\n` +
      `Name: *${data.name}*\n` +
      `Department: *${data.department}*\n` +
      `Complaint: ${data.complaint}\n\n` +
      `_Please call the patient in now._\n\n` +
      `Dashboard: ${DASHBOARD_URL}`;
  }

  if (config.receptionist_whatsapp) {
    await sendWhatsApp(config.receptionist_whatsapp, clinicMsg);
  }

  io.emit('queue_updated', { type, data });
}

// ─── APPOINTMENT REMINDER ─────────────────────────────
async function checkAndSendReminders() {
  try {
    const now = new Date();
    const thirtyMinsLater = new Date(now.getTime() + 30 * 60 * 1000);
    const result = await pool.query(
      `SELECT * FROM appointments
       WHERE status = 'scheduled'
       AND appointment_time > $1
       AND appointment_time <= $2`,
      [now.toTimeString().slice(0, 8), thirtyMinsLater.toTimeString().slice(0, 8)]
    );
    for (const appt of result.rows) {
      const cfg = await getConfig();
      const message =
        `*Reminder from Zero*\n\n` +
        `Hi *${appt.name}*, your appointment at *${cfg.clinic_name}* is in 30 minutes.\n\n` +
        `Are you:\n1. On my way / Already here\n2. Cancel appointment\n\n` +
        `_Please reply so we can prepare for you._`;
      await sendWhatsApp(appt.phone, message);
      await pool.query(`UPDATE appointments SET status = 'reminder_sent' WHERE id = $1`, [appt.id]);
    }
  } catch (e) {
    addLog('error', 'Reminder error', e.message);
  }
}

setInterval(checkAndSendReminders, 5 * 60 * 1000);

// ─── ZERO AI BRAIN ────────────────────────────────────
async function zeroAI(message, history, collectedData, config) {
  const displayData = {
    name: collectedData.name || null,
    age: collectedData.age || null,
    gender: collectedData.gender || null,
    complaint: collectedData.complaint || null,
    symptoms: collectedData.symptoms || null,
    appointment_date: collectedData.appointment_date || null,
    appointment_time: collectedData.appointment_time || null,
  };

  const systemPrompt = `You are Zero, a warm and compassionate clinic assistant for ${config.clinic_name}.
You help patients register through WhatsApp. You have deep clinical knowledge and use it to ask precise, relevant follow-up questions.

CURRENT PATIENT DATA ALREADY COLLECTED:
${JSON.stringify(displayData)}

CURRENT MODE: ${collectedData.mode || 'walkin'} (already set — do not ask patient about this)

YOUR JOB:
Look at what is already collected above. Find what is STILL MISSING. Ask for ONLY the next missing piece, ONE question at a time.

REQUIRED FIELDS:
- name: patient full name
- age: number (extract from "I'm 45", "45 years old", "age 45" etc.)
- gender: Male/Female/Prefer not to say (accept m/f/1/2/3/male/female)
- complaint: main reason for visit
- symptoms: relevant details specific to their complaint
- appointment_date: ONLY if mode is "appointment"
- appointment_time: ONLY if mode is "appointment"

COLLECTION ORDER:
1. name, age, gender (can be in one message)
2. complaint
3. symptoms (smart, specific follow-up based on complaint)
4. If appointment mode: date then time
5. All fields collected: set is_complete to true

━━━━━━━━━━━━━━━━━━━━━━━━
TONE & EMPATHY
━━━━━━━━━━━━━━━━━━━━━━━━
You are warm, caring, and human. The person messaging may be unwell, anxious, or in pain.

Empathy rules:
- Show empathy ONCE at the start of the symptom collection phase — not before every single question
- Use VARIED acknowledgements. Do not repeat the same phrase twice in one conversation.
  Good examples: "That sounds uncomfortable.", "Understood.", "Got it, thank you for sharing that.", "I hear you.", "That must be difficult."
  Bad: "I'm sorry to hear that." repeated every message.
- After the first empathetic acknowledgement, ask follow-up questions directly and warmly — no need to re-acknowledge before each one
- If the patient shares something serious (chest pain, severe symptoms), a brief "That's concerning — let's make sure you're seen quickly." is appropriate. Do not overuse this.
- Never sound like a form or an automated system
- Match their energy — if they are brief, be concise. If they share a lot, be warm and attentive.
- NO emoji in your replies. Write plainly and warmly.

NAME USAGE — READ THIS CAREFULLY:
Use the patient's name ONLY TWICE in the ENTIRE conversation:
  1. The FIRST time you acknowledge their name: e.g. "Thanks [Name]. What brings you in today?"
  2. The FINAL confirmation message only.
In ALL other messages: do NOT use the name. Not once.
Using the name in every reply sounds robotic and impersonal. It must not happen.

━━━━━━━━━━━━━━━━━━━━━━━━
MEDICAL INTELLIGENCE
━━━━━━━━━━━━━━━━━━━━━━━━
You understand medical conditions deeply. Use this knowledge to ask the RIGHT follow-up questions.

DENTAL & ORTHODONTIC (braces, alignment, gaps, spacing, crowding, missing teeth):
→ Braces are orthodontic devices for teeth alignment — NOT related to toothache
→ Ask: How long have you been considering this? Any pain or sensitivity currently? Upper, lower, or both?

DENTAL PAIN (toothache, cavity, abscess, gum pain, sensitivity):
→ Ask: Which tooth or area? Sharp or dull ache? Constant or triggered by hot/cold? Any swelling?

CARDIAC (chest pain, palpitations, racing heart, shortness of breath):
→ Ask: Is it sharp, crushing, or pressure-like? Does it spread to your arm or jaw? Any sweating or dizziness?
→ Chest pain with radiation = HIGH urgency

MUSCULOSKELETAL (back pain, joint pain, knee, shoulder, sports injury):
→ Ask: Which area exactly? Sudden injury or gradual onset? Any swelling or bruising?

NEUROLOGICAL (headache, migraine, dizziness, numbness, seizure, memory):
→ Ask: Where is the pain located? How frequent? Any nausea, visual changes, or light sensitivity?

RESPIRATORY (cough, asthma, breathing difficulty, wheezing):
→ Ask: Dry or productive cough? Any fever? Breathless at rest or on exertion? How many days?

GASTROINTESTINAL (stomach pain, nausea, vomiting, diarrhea, constipation):
→ Ask: Where in the abdomen? Any blood? After eating or unrelated? How many days?

DERMATOLOGY (rash, itching, skin lesion, acne, eczema):
→ Ask: Which part of the body? How long? Spreading? Known allergies or triggers?

EYE / ENT (eye pain, ear pain, sore throat, nasal congestion, hearing loss):
→ Ask: Which eye or ear? Any discharge, redness, or vision/hearing change? Duration?

REPRODUCTIVE / GYNAECOLOGY:
→ Ask sensitively and briefly. Duration and severity only unless patient volunteers more.

GENERAL / UNKNOWN:
→ Ask: How long have you had this? Getting better or worse? Any other symptoms alongside it?

━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL RULES
━━━━━━━━━━━━━━━━━━━━━━━━
1. NEVER ask for anything already in CURRENT PATIENT DATA
2. NEVER invent or assume a symptom the patient did not mention
3. Accept the patient's complaint VERBATIM — do NOT rename or reinterpret it
4. Ask ONE question at a time — this is WhatsApp, not a form
5. Show empathy first, then ask the next question
6. Set is_complete = true ONLY when every required field is filled
7. "mode" is already set in collected data — NEVER ask about mode
8. Write NO emoji in your reply field
9. The patient's phone number is already known from WhatsApp. NEVER ask for it under any circumstances.

INTENT DETECTION:
- "doctor_done": message is exactly "done", "next", "next patient", "mark done", "mark complete"
- "restart": message is "restart", "start over", "reset", "menu"
- "check_queue": message is "queue", "check queue", "my number", "queue status"
- "cancel_appointment": patient explicitly says cancel appointment
- "collecting": everything else

RESPOND ONLY WITH THIS JSON:
{
  "reply": "your short warm WhatsApp response — no emoji",
  "extracted": {
    "name": null,
    "age": null,
    "gender": null,
    "complaint": null,
    "symptoms": null,
    "appointment_date": null,
    "appointment_time": null
  },
  "is_complete": false,
  "intent": "collecting"
}

Only include extracted fields you ACTUALLY found. Set is_complete true only when ALL required fields are present in CURRENT PATIENT DATA after merging.`;

const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: h.content
    }))
  ];

  let rawText = '';
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.3,
      max_tokens: 500,
      response_format: { type: 'json_object' }
    });
    rawText = completion.choices[0].message.content;

    // Strip markdown fences if Gemini wraps the JSON (happens intermittently)
    rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    const parsed = JSON.parse(rawText);

    // Validate the shape — if the model returns garbage, throw so we fallback cleanly
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Invalid JSON shape from Gemini');
    }

    return parsed;

  } catch (e) {
    addLog('error', 'Groq zeroAI parse/call error', `${e.message} | raw: ${rawText.slice(0, 200)}`);
    // Return a safe fallback object that keeps the conversation alive
    // instead of throwing and triggering the generic error message
    return {
      reply: "Could you say that again? I want to make sure I get your details right.",
      extracted: {},
      is_complete: false,
      intent: 'collecting'
    };
  }
}
// ─── AI ROUTING ───────────────────────────────────────
async function getAIRouting(complaint, symptoms) {
  const prompt = `Classify this clinic patient's complaint.\n\nComplaint: ${complaint}\nSymptoms: ${symptoms || 'none provided'}\n\nReturn JSON only: {"department": "...", "urgency": "Low|Medium|High", "summary": "one-line summary"}\n\nDepartment options: General, Dental, Cardiology, Neurology, Respiratory, Gastroenterology, Dermatology, ENT, Orthopaedics, Gynaecology, Ophthalmology, Laboratory`;
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 100,
      response_format: { type: 'json_object' }
    });
    return JSON.parse(completion.choices[0].message.content);
  } catch (e) {
    addLog('error', 'AI routing error', e.message);
    return { department: 'General', urgency: 'Low', summary: complaint };
  }
}

// ─── SAVE PATIENT ─────────────────────────────────────
async function savePatient(data, queueNumber, routing) {
  const result = await pool.query(
    `INSERT INTO patients
     (phone, name, age, gender, complaint, symptoms, department, urgency, queue_number, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'waiting') RETURNING *`,
    [data.phone, data.name, data.age, data.gender,
     data.complaint, data.symptoms,
     routing.department, routing.urgency, queueNumber]
  );
  addLog('info', `Patient saved: ${data.name} | Queue #${queueNumber} | ${routing.department}`);
  return result.rows[0];
}

// ─── SAVE APPOINTMENT ─────────────────────────────────
async function saveAppointment(data, routing) {
  const result = await pool.query(
    `INSERT INTO appointments
     (phone, name, age, gender, complaint, department, appointment_date, appointment_time, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'scheduled') RETURNING *`,
    [data.phone, data.name, data.age, data.gender,
     data.complaint, routing.department,
     data.appointment_date, data.appointment_time]
  );
  addLog('info', `Appointment saved: ${data.name} | ${data.appointment_date} ${data.appointment_time}`);
  return result.rows[0];
}

// ─── BUILD WELCOME MESSAGE ────────────────────────────
function buildWelcome(config, greeting, isReturn = false) {
  const services = config.services || ['General Consultation', 'Dental Care', 'Cardiology', 'Neurology', 'Laboratory Tests'];
  const serviceList = services.map(s => `- ${s}`).join('\n');
  return `${greeting}. I'm *${config.agent_name}*, your clinic assistant.\n\n` +
    `Welcome${isReturn ? ' back' : ''} to *${config.clinic_name}*.\n\n` +
    `Services we offer:\n${serviceList}\n\n` +
    `How can I help you today?\n\n` +
    `1. Walk-in registration\n` +
    `2. Book an appointment\n` +
    `3. I'm on my way to the clinic\n` +
    `4. Check my queue status`;
}

// ─── DETECT MENU SELECTION ────────────────────────────
function detectMenuSelection(msg) {
  if (msg === '1' || msg.includes('walk') || msg.includes('already at') || msg.includes('at the clinic')) return 'walkin';
  if (msg === '2' || msg.includes('book') || msg.includes('appointment') || msg.includes('schedule')) return 'appointment';
  if (msg === '3' || msg.includes('on my way') || msg.includes('coming') || msg.includes('otw')) return 'onmyway';
  if (msg === '4' || msg.includes('queue') || msg.includes('my number') || msg.includes('status')) return 'check_queue';
  return null;
}

// ─── PROCESS MESSAGE ──────────────────────────────────
async function processMessage(phone, message) {
  const conv = await getConversation(phone);
  const config = await getConfig();
  const greeting = getGreeting();

  let data = conv.data || {};
  let history = data.history || [];
  data.phone = phone;

  const msg = message.trim().toLowerCase();
  const now = new Date().toISOString();

  // ── RESTART ──
  if (['restart', 'reset', 'start over', 'menu'].includes(msg)) {
    const welcomeMsg = `Your session has been restarted.`;
    await updateConversation(phone, 'START', {});
    return welcomeMsg;
  }

  // ── FIRST TIME ──
  if (conv.state === 'START') {
    const welcomeMsg = buildWelcome(config, greeting, false);
    history = [{ role: 'assistant', content: welcomeMsg, timestamp: now }];
    data.history = history;
    await updateConversation(phone, 'MENU', data);
    return welcomeMsg;
  }

  // ── MENU STATE ──
  if (conv.state === 'MENU') {
    const selection = detectMenuSelection(msg);

    if (selection === 'check_queue') {
      const patient = await pool.query(
        'SELECT * FROM patients WHERE phone = $1 AND status = $2', [phone, 'waiting']
      );
      if (patient.rows.length > 0) {
        const p = patient.rows[0];
        return `Your queue status:\n\nQueue Number: *#${p.queue_number}*\nDepartment: *${p.department}*\nStatus: Waiting\n\nPlease remain seated. I'll notify you when it's your turn.`;
      }
      return `You don't have an active queue number yet.\n\nReply *1* for walk-in or *2* to book an appointment.`;
    }

    if (selection) {
      data.mode = selection;
      history.push({ role: 'user', content: message, timestamp: now });

      let modeReply = '';
      if (selection === 'walkin') modeReply = `Let's get you registered. Could you share your *full name, age and gender*?`;
      if (selection === 'appointment') modeReply = `I'll help you book an appointment. Could you share your *full name, age and gender*?`;
      if (selection === 'onmyway') modeReply = `Got it. Let's take your details so the clinic is ready when you arrive. Could you share your *full name, age and gender*?`;

      history.push({ role: 'assistant', content: modeReply, timestamp: now });
      data.history = history.slice(-20);
      await updateConversation(phone, 'ACTIVE', data);
      return modeReply;
    }

    return `I didn't quite catch that. Please choose an option:\n\n` +
      `1. Walk-in registration\n` +
      `2. Book an appointment\n` +
      `3. I'm on my way\n` +
      `4. Check my queue number\n\n` +
      `_(Reply with a number or keyword)_`;
  }

  // ── DONE STATE — patient messaging again after completed flow ──
  if (conv.state === 'DONE') {
    const welcomeMsg = buildWelcome(config, greeting, true);
    const freshHistory = [{ role: 'assistant', content: welcomeMsg, timestamp: now }];
    data.history = freshHistory;
    await updateConversation(phone, 'MENU', data);
    return welcomeMsg;
  }

  // ── ACTIVE — collecting patient info ──
  history.push({ role: 'user', content: message, timestamp: now });

  // Doctor queue commands
  if (['done', 'next', 'next patient', 'mark done', 'mark complete'].includes(msg)) {
    const current = await pool.query(
      `SELECT * FROM patients WHERE status = 'waiting' ORDER BY queue_number ASC LIMIT 1`
    );
    if (current.rows.length > 0) {
      await pool.query('UPDATE patients SET status = $1 WHERE id = $2', ['seen', current.rows[0].id]);
      const next = await pool.query(
        `SELECT * FROM patients WHERE status = 'waiting' ORDER BY queue_number ASC LIMIT 1`
      );
      if (next.rows.length > 0) {
        const n = next.rows[0];
        await sendWhatsApp(n.phone, `*Hi ${n.name}.* It's your turn.\n\nPlease proceed to the consultation room. The doctor is ready for you.\n\n_— Zero_`);
        await notifyClinic('next', { queueNumber: n.queue_number, name: n.name, department: n.department, complaint: n.complaint }, config);
        io.emit('queue_updated', { type: 'next' });
        return `Patient #${current.rows[0].queue_number} marked as seen.\n\n*Next:* ${n.name} — #${n.queue_number}`;
      }
      io.emit('queue_updated', { type: 'done' });
      return `Patient marked as seen.\n\nNo more patients in queue.`;
    }
    return `No active patients in the queue.`;
  }

  if (['queue', 'check queue', 'my number', 'queue status'].includes(msg)) {
    const patient = await pool.query('SELECT * FROM patients WHERE phone = $1 AND status = $2', [phone, 'waiting']);
    if (patient.rows.length > 0) {
      const p = patient.rows[0];
      return `Your queue status:\n\nQueue Number: *#${p.queue_number}*\nDepartment: ${p.department}\nStatus: Waiting\n\nI'll notify you when it's your turn.`;
    }
    return `You don't have an active queue number yet.`;
  }

   // ── CALL ZERO AI ──
  // zeroAI handles its own errors and returns a safe fallback — no try/catch needed here.
  // A hard throw from zeroAI would only happen in a truly unexpected scenario,
  // which the outer webhook try/catch will handle.
  const aiResponse = await zeroAI(message, history.slice(-20), data, config);

  // ── MERGE EXTRACTED DATA ──
  if (aiResponse.extracted) {
    Object.keys(aiResponse.extracted).forEach(key => {
      if (aiResponse.extracted[key] !== null && aiResponse.extracted[key] !== undefined) {
        data[key] = aiResponse.extracted[key];
      }
    });
  }

  // ── CANCEL APPOINTMENT ──
  if (aiResponse.intent === 'cancel_appointment') {
    await pool.query(
      `UPDATE appointments SET status = 'cancelled' WHERE phone = $1 AND status IN ('scheduled', 'reminder_sent')`,
      [phone]
    );
    await updateConversation(phone, 'START', {});
    return `Your appointment has been cancelled${data.name ? ', ' + data.name : ''}.\n\nMessage us anytime to rebook.\n\n_— Zero_`;
  }

  // ── HANDLE COMPLETE INTAKE ──
  if (aiResponse.is_complete) {

    if (!data.name || !data.age || !data.gender) {
      const reply = `Could you share your full name, age and gender?`;
      history.push({ role: 'assistant', content: reply, timestamp: now });
      data.history = history.slice(-20);
      await updateConversation(phone, 'ACTIVE', data);
      return reply;
    }

    if (!data.complaint) {
      const reply = `What brings you to the clinic today?`;
      history.push({ role: 'assistant', content: reply, timestamp: now });
      data.history = history.slice(-20);
      await updateConversation(phone, 'ACTIVE', data);
      return reply;
    }

    if (!data.symptoms) {
      const reply = `Can you tell me a bit more about what you're experiencing?`;
      history.push({ role: 'assistant', content: reply, timestamp: now });
      data.history = history.slice(-20);
      await updateConversation(phone, 'ACTIVE', data);
      return reply;
    }

    if (data.mode === 'appointment') {
      if (!data.appointment_date) {
        const reply = `What date would you like to come in?\n_(e.g. "Tomorrow", "Monday", "27th May")_`;
        history.push({ role: 'assistant', content: reply, timestamp: now });
        data.history = history.slice(-20);
        await updateConversation(phone, 'ACTIVE', data);
        return reply;
      }
      if (!data.appointment_time) {
        const reply = `And what time works for you?\n_(e.g. "9am", "2pm", "afternoon")_`;
        history.push({ role: 'assistant', content: reply, timestamp: now });
        data.history = history.slice(-20);
        await updateConversation(phone, 'ACTIVE', data);
        return reply;
      }

      const routing = await getAIRouting(data.complaint, data.symptoms || '');
      await saveAppointment(data, routing);
      await notifyClinic('appointment', {
        name: data.name, age: data.age, gender: data.gender,
        phone, complaint: data.complaint, department: routing.department,
        appointment_date: data.appointment_date, appointment_time: data.appointment_time
      }, config);
      io.emit('queue_updated', { type: 'appointment' });

      const confirmMsg = `*Appointment confirmed, ${data.name}.*\n\nDate: *${data.appointment_date}*\nTime: *${data.appointment_time}*\nDepartment: *${routing.department}*\n\nPlease arrive 10 minutes early.\n\n_See you soon — Zero_`;
      history.push({ role: 'assistant', content: confirmMsg, timestamp: now });
      await updateConversation(phone, 'DONE', { ...data, history: history.slice(-50) });
      return confirmMsg;
    }

    const routing = await getAIRouting(data.complaint, data.symptoms || '');

    if (data.mode === 'onmyway') {
      await notifyClinic('onmyway', {
        name: data.name, age: data.age, gender: data.gender,
        phone, complaint: data.complaint, symptoms: data.symptoms || '',
        department: routing.department, urgency: routing.urgency, summary: routing.summary
      }, config);
      io.emit('queue_updated', { type: 'onmyway' });

      const onWayMsg = `*Got it, ${data.name}.*\n\nThe clinic has been notified you're on your way.\n\nLikely Department: *${routing.department}*\n\nA queue number will be assigned when you arrive.\n\n_See you soon — Zero_`;
      history.push({ role: 'assistant', content: onWayMsg, timestamp: now });
      await updateConversation(phone, 'DONE', { ...data, history: history.slice(-50) });
      return onWayMsg;
    }

    // ── WALK-IN ──
    const queueNumber = await getNextQueueNumber();
    await savePatient(data, queueNumber, routing);
    await notifyClinic('walkin', {
      queueNumber, name: data.name, age: data.age, gender: data.gender,
      phone, complaint: data.complaint, symptoms: data.symptoms || '',
      department: routing.department, urgency: routing.urgency, summary: routing.summary
    }, config);
    io.emit('queue_updated', { type: 'walkin', queueNumber });

    const walkinMsg = `*You're all set, ${data.name}.*\n\nQueue Number: *#${queueNumber}*\nDepartment: *${routing.department}*\nUrgency: *${routing.urgency}*\n\nPlease take a seat at reception. I'll message you when it's your turn.\n\n_Thank you for your patience — Zero_`;
    history.push({ role: 'assistant', content: walkinMsg, timestamp: now });
    await updateConversation(phone, 'DONE', { ...data, history: history.slice(-50) });
    return walkinMsg;
  }

  // ── CONTINUE CONVERSATION ──
  history.push({ role: 'assistant', content: aiResponse.reply, timestamp: now });
  data.history = history.slice(-20);
  await updateConversation(phone, 'ACTIVE', data);
  return aiResponse.reply;
}

// ─── PHARMACY UTILITIES ───────────────────────────────

function formatCurrency(amount, currency = 'NGN') {
  const symbols = { NGN: '₦', USD: '$', GHS: '₵', KES: 'KSh' };
  const sym = symbols[currency] || (currency + ' ');
  return `${sym}${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// ─── PHARMACY FUZZY PRODUCT MATCH ────────────────────
function fuzzyMatchProducts(query, products) {
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

// ─── PHARMACY AI BRAIN ────────────────────────────────
async function pharmacyAI(message, history, collectedData, products, pharmacyConfig) {
  const productList = products.length
    ? products.map(p =>
        `- ${p.name} (${p.rx_required ? 'Rx' : 'OTC'}, ${p.stock_qty > 0 ? 'in stock' : 'out of stock'})`
      ).join('\n')
    : 'No products currently available.';

  const state = {
    phase: collectedData.phase || 'product',
    product_confirmed: collectedData.product_id ? collectedData.product_name : null,
    qty_collected: collectedData.qty || null,
    rx_required: collectedData.product_rx_required || false,
    rx_confirmed: collectedData.rx_confirmed ?? null,
    cart_count: (collectedData.cart || []).length,
    fulfilment: collectedData.fulfilment || null,
    area: collectedData.area || null,
  };

  const systemPrompt = `You are Zara, a pharmacy sales assistant for ${pharmacyConfig.pharmacy_name}.
Your ONLY role is to help customers place product orders. You are not a pharmacist and you never give medical, dosage, or drug-interaction advice.

PRODUCT CATALOGUE (these are the ONLY products that exist — never reference anything else):
${productList}

CURRENT ORDER STATE:
${JSON.stringify(state)}

YOUR JOB:
Read the current order state. Ask for ONLY the next missing piece. One question at a time.

PHASE GUIDE:
- phase "product": if product_confirmed is null → find out what product the customer wants (extract product_name_mentioned). If product_confirmed is set but qty_collected is null → ask how many.
- phase "rx_confirm": rx_required is true and rx_confirmed is null → ask the customer to confirm they have a valid prescription. Give no medical information whatsoever.
- phase "more_or_checkout": cart has items → ask if they want to add more or checkout.
- phase "delivery": if fulfilment is null → ask delivery or pickup. If DELIVERY and area is null → ask delivery area.
- phase "confirm": order summary is shown by the server → detect yes/no only.

TONE & HYGIENE:
- Warm, brief, plain text. No emoji. No markdown bold in the reply field.
- Vary acknowledgement phrases. Never repeat the same phrase twice.
- Use the customer's name ONLY TWICE in the entire conversation: once when they first share it, once in the final confirmation.
- Never ask for the customer's phone number.
- If the customer asks about drug interactions, side effects, dosage, or whether a medicine is right for them: reply exactly "I can only help with placing your order. Please speak to a pharmacist or your doctor for medical questions."

CRITICAL FINANCIAL RULE:
Never state a price, subtotal, delivery fee, or total in your reply. The server handles all money display.

INTENT VALUES: order | browse | track | cancel | collecting

RESPOND ONLY WITH THIS JSON — no extra text:
{
  "reply": "...",
  "extracted": {
    "product_name_mentioned": null,
    "qty": null,
    "fulfilment": null,
    "area": null,
    "rx_confirmed": null
  },
  "intent": "collecting"
}

Only populate extracted fields you actually observed in the customer's message.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content }))
  ];

  let rawText = '';
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.3,
      max_tokens: 400,
      response_format: { type: 'json_object' }
    });
    rawText = completion.choices[0].message.content;
    rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(rawText);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid JSON shape');
    return parsed;
  } catch (e) {
    addLog('error', 'Groq pharmacyAI parse/call error', `${e.message} | raw: ${rawText.slice(0, 200)}`);
    return {
      reply: "Could you say that again? I want to make sure I get your order right.",
      extracted: {},
      intent: 'collecting'
    };
  }
}

// ─── ORDER SUMMARY (server-computed, no LLM) ──────────
function buildOrderSummary(data, pharmacyConfig) {
  const currency = pharmacyConfig.currency || 'NGN';
  const fee = data.fulfilment === 'DELIVERY' ? (parseFloat(pharmacyConfig.delivery_fee) || 0) : 0;
  const subtotal = data.cart.reduce((s, i) => s + i.price_snap * i.qty, 0);
  const total = subtotal + fee;
  const lines = data.cart.map(i => `${i.name_snap} x${i.qty} — ${formatCurrency(i.price_snap * i.qty, currency)}`);
  let msg = `Order Summary\n\n${lines.join('\n')}\n\nSubtotal: ${formatCurrency(subtotal, currency)}\n`;
  if (data.fulfilment === 'DELIVERY') {
    msg += `Delivery to ${data.area}: ${formatCurrency(fee, currency)}\n`;
  } else {
    msg += `Fulfilment: Pickup\n`;
  }
  msg += `Total: ${formatCurrency(total, currency)}\n\nReply YES to confirm or NO to cancel.`;
  return msg;
}

// ─── ADD PRODUCT TO CART AND PROMPT ───────────────────
async function addToCartAndPrompt(data, history, phone, pharmacyConfig, now) {
  const currency = pharmacyConfig.currency || 'NGN';
  data.cart.push({
    product_id: data.product_id,
    name_snap: data.product_name,
    price_snap: data.product_price,
    qty: data.qty,
    rx_required: data.product_rx_required
  });
  data.product_id = null;
  data.product_name = null;
  data.product_price = null;
  data.product_rx_required = false;
  data.rx_confirmed = null;
  data.qty = null;
  data.phase = 'more_or_checkout';

  const cartLines = data.cart.map(i => `${i.name_snap} x${i.qty} — ${formatCurrency(i.price_snap * i.qty, currency)}`);
  const subtotal = data.cart.reduce((s, i) => s + i.price_snap * i.qty, 0);
  const reply = `Added to your cart.\n\nCart:\n${cartLines.join('\n')}\nSubtotal: ${formatCurrency(subtotal, currency)}\n\nWould you like to add another item, or type checkout to proceed?`;
  history.push({ role: 'assistant', content: reply, timestamp: now });
  data.history = history.slice(-20);
  await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
  return reply;
}

// ─── PAYMENT HELPERS ──────────────────────────────────

function verifyPaystackSignature(rawBody, signatureHeader, secret) {
  const hash = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');
  return hash === signatureHeader;
}

async function initializePaystackPayment(orderId, totalNaira, customerPhone, reference, pharmacyConfig) {
  const amountKobo = Math.round(totalNaira * 100);
  const response = await axios.post(
    'https://api.paystack.co/transaction/initialize',
    {
      amount: amountKobo,
      reference,
      // email is required by Paystack; derive a placeholder from phone
      email: `${customerPhone.replace(/[^0-9]/g, '')}@whatsapp.pharmacy`,
      metadata: { order_id: orderId, pharmacy_id: pharmacyConfig.id, customer_phone: customerPhone }
    },
    {
      headers: {
        Authorization: `Bearer ${pharmacyConfig.paystack_secret_key}`,
        'Content-Type': 'application/json'
      }
    }
  );
  // returns { reference, authorization_url, access_code }
  return response.data.data;
}

// Atomically marks an order PAID and decrements stock.
// Returns the updated order row, or null if already paid / not found.
async function confirmOrderPayment(orderId, paymentRef, pharmacyId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query(
      `UPDATE orders SET status = 'PAID', payment_ref = $1, paid_at = NOW()
       WHERE id = $2 AND pharmacy_id = $3 AND status != 'PAID'
       RETURNING *`,
      [paymentRef, orderId, pharmacyId]
    );
    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return null; // already paid or not found
    }
    const order = orderRes.rows[0];

    const items = await client.query(
      'SELECT * FROM order_items WHERE order_id = $1',
      [orderId]
    );
    for (const item of items.rows) {
      await client.query(
        `UPDATE products SET stock_qty = GREATEST(stock_qty - $1, 0) WHERE id = $2`,
        [item.qty, item.product_id]
      );
      await client.query(
        `INSERT INTO inventory_log (product_id, change, reason, order_id) VALUES ($1, $2, 'SALE', $3)`,
        [item.product_id, -item.qty, orderId]
      );
    }

    await client.query('COMMIT');
    return order;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function notifyCustomerPaymentConfirmed(order, pharmacy) {
  const currency = pharmacy.currency || 'NGN';
  const ref = `ZPHARM-${order.id}`;
  let msg = `Payment received. Thank you!\n\nOrder ${ref}\nTotal: ${formatCurrency(order.total, currency)}\n\n`;
  if (order.fulfilment === 'DELIVERY') {
    const area = order.delivery_area ? ` to ${order.delivery_area}` : '';
    msg += `Your order is being prepared for delivery${area}.`;
    if (pharmacy.delivery_note) msg += `\n${pharmacy.delivery_note}`;
  } else {
    msg += `Your order is being prepared. We will let you know when it is ready for collection.`;
  }
  await sendWhatsApp(order.customer_phone, msg, pharmacy.phone_number_id);
}

// ─── PHARMACY MESSAGE PROCESSOR ───────────────────────
async function processPharmacyMessage(phone, message, pharmacyConfig) {
  const conv = await getPharmacyConversation(phone, pharmacyConfig.id);
  const msg = message.trim().toLowerCase();
  const now = new Date().toISOString();

  let data = conv.data || {};
  data.pharmacy_id = pharmacyConfig.id;
  if (!data.cart) data.cart = [];

  let history = data.history || [];
  const currency = pharmacyConfig.currency || 'NGN';
  const deliveryFee = parseFloat(pharmacyConfig.delivery_fee) || 0;

  // ── GLOBAL RESETS ──
  if (['restart', 'reset', 'start over'].includes(msg)) {
    await updatePharmacyConversation(phone, pharmacyConfig.id, 'START', {});
    return `Session restarted. Send a message to begin.`;
  }

  // ── START ──
  if (conv.state === 'START') {
    const greeting = getGreeting();
    const welcome = `${greeting}. Welcome to *${pharmacyConfig.pharmacy_name}*.\n\nI'm Zara, your pharmacy assistant. Tell me what you need — I can help you order products, check what's in stock, or track a previous order.`;
    history = [{ role: 'assistant', content: welcome, timestamp: now }];
    data.history = history;
    await updatePharmacyConversation(phone, pharmacyConfig.id, 'MENU', data);
    return welcome;
  }

  // ── DONE — customer returns ──
  if (conv.state === 'DONE') {
    const welcome = `Welcome back to *${pharmacyConfig.pharmacy_name}*. What can I help you with?`;
    history = [{ role: 'assistant', content: welcome, timestamp: now }];
    data = { pharmacy_id: pharmacyConfig.id, cart: [], history };
    await updatePharmacyConversation(phone, pharmacyConfig.id, 'MENU', data);
    return welcome;
  }

  // ── MENU — detect intent, move to ACTIVE ──
  if (conv.state === 'MENU') {
    history.push({ role: 'user', content: message, timestamp: now });

    if (msg.includes('track') || msg.includes('my order') || msg.includes('order status')) {
      const orders = await pool.query(
        `SELECT id, status, total, created_at FROM orders WHERE customer_phone = $1 AND pharmacy_id = $2 ORDER BY created_at DESC LIMIT 5`,
        [phone, pharmacyConfig.id]
      );
      let reply;
      if (orders.rows.length === 0) {
        reply = `You have no orders with us yet. Tell me what product you need and I will help you place one.`;
      } else {
        const lines = orders.rows.map(o => `ORD-${String(o.id).padStart(5, '0')} — ${o.status} — ${formatCurrency(o.total, currency)}`);
        reply = `Your recent orders:\n\n${lines.join('\n')}\n\nIs there anything else I can help you with?`;
      }
      history.push({ role: 'assistant', content: reply, timestamp: now });
      data.history = history.slice(-20);
      await updatePharmacyConversation(phone, pharmacyConfig.id, 'MENU', data);
      return reply;
    }

    // Any other message — move to ACTIVE and handle as product inquiry
    data.phase = 'product';
    data.product_id = null;
    data.product_name = null;
    data.product_price = null;
    data.product_rx_required = false;
    data.rx_confirmed = null;
    data.qty = null;
    data.history = history.slice(-20);
    await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
    conv.state = 'ACTIVE'; // fall through below
  }

  // ── ACTIVE — full AI-driven order collection ──
  if (conv.state === 'ACTIVE') {
    // Avoid duplicating user message if MENU already pushed it
    const last = history[history.length - 1];
    if (!last || last.role !== 'user' || last.content !== message) {
      history.push({ role: 'user', content: message, timestamp: now });
    }

    const phase = data.phase || 'product';

    // ── PHASE: CONFIRM ──
    if (phase === 'confirm') {
      if (['yes', 'y', 'confirm', 'ok', 'sure'].includes(msg)) {
        const subtotal = data.cart.reduce((s, i) => s + i.price_snap * i.qty, 0);
        const fee = data.fulfilment === 'DELIVERY' ? deliveryFee : 0;
        const total = subtotal + fee; // all math in server code, never LLM

        const orderResult = await pool.query(
          `INSERT INTO orders (pharmacy_id, customer_phone, customer_name, status, fulfilment, subtotal, delivery_fee, total, conversation_id, delivery_area)
           VALUES ($1, $2, $3, 'PENDING', $4, $5, $6, $7, $8, $9) RETURNING id`,
          [pharmacyConfig.id, phone, data.customer_name || null, data.fulfilment, subtotal, fee, total, phone, data.area || null]
        );
        const orderId = orderResult.rows[0].id;

        // Insert order line items — inventory only decrements on confirmed payment, never here
        for (const item of data.cart) {
          await pool.query(
            `INSERT INTO order_items (order_id, product_id, name_snap, price_snap, qty) VALUES ($1, $2, $3, $4, $5)`,
            [orderId, item.product_id, item.name_snap, item.price_snap, item.qty]
          );
        }

        const needsRxReview = data.cart.some(i => i.rx_required);
        if (needsRxReview) {
          await pool.query(`UPDATE orders SET status = 'PENDING_RX_REVIEW' WHERE id = $1`, [orderId]);
        }

        const orderRef = `ZPHARM-${orderId}`;
        let confirmMsg;

        if (!needsRxReview && pharmacyConfig.payment_provider === 'paystack' && pharmacyConfig.paystack_secret_key) {
          try {
            const payment = await initializePaystackPayment(orderId, total, phone, orderRef, pharmacyConfig);
            await pool.query(
              `UPDATE orders SET payment_ref = $1, payment_link = $2 WHERE id = $3`,
              [payment.reference, payment.authorization_url, orderId]
            );
            confirmMsg = `Your order is confirmed.\n\nReference: ${orderRef}\nTotal: ${formatCurrency(total, currency)}\n\nComplete your payment here:\n${payment.authorization_url}\n\nYour order will be processed as soon as payment is received. Thank you for ordering from ${pharmacyConfig.pharmacy_name}.`;
          } catch (e) {
            addLog('error', 'Paystack init failed', e.message);
            confirmMsg = `Your order is confirmed.\n\nReference: ${orderRef}\nTotal: ${formatCurrency(total, currency)}\n\nOur team will contact you with payment details shortly. Thank you for ordering from ${pharmacyConfig.pharmacy_name}.`;
          }
        } else if (!needsRxReview && pharmacyConfig.payment_provider === 'manual' && pharmacyConfig.manual_payment_details) {
          confirmMsg = `Your order is confirmed.\n\nReference: ${orderRef}\nTotal: ${formatCurrency(total, currency)}\n\nPlease pay via:\n${pharmacyConfig.manual_payment_details}\n\nUse reference ${orderRef} when making your transfer. Thank you for ordering from ${pharmacyConfig.pharmacy_name}.`;
        } else {
          const rxNote = needsRxReview
            ? `One or more items require a valid prescription. Our team will verify before processing.\n\n`
            : '';
          confirmMsg = `Your order is confirmed.\n\n${rxNote}Reference: ${orderRef}\nTotal: ${formatCurrency(total, currency)}\n\nOur team will be in touch with next steps. Thank you for ordering from ${pharmacyConfig.pharmacy_name}.`;
        }

        history.push({ role: 'assistant', content: confirmMsg, timestamp: now });
        data.cart = [];
        data.phase = null;
        await updatePharmacyConversation(phone, pharmacyConfig.id, 'DONE', { ...data, history: history.slice(-50) });
        io.emit('queue_updated', { type: 'pharmacy_order', orderId, pharmacyId: pharmacyConfig.id, needsRxReview });
        addLog('info', `Pharmacy order: ${orderRef} | ${pharmacyConfig.pharmacy_name} | ${formatCurrency(total, currency)}`);
        return confirmMsg;
      }

      if (['no', 'n', 'cancel'].includes(msg)) {
        data.phase = 'more_or_checkout';
        const reply = data.cart.length
          ? `Order cancelled. Your cart still has ${data.cart.length} item(s). Type checkout to try again or clear to empty your cart.`
          : `Order cancelled. Tell me what you need.`;
        history.push({ role: 'assistant', content: reply, timestamp: now });
        data.history = history.slice(-20);
        await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
        return reply;
      }

      const summary = buildOrderSummary(data, pharmacyConfig);
      history.push({ role: 'assistant', content: summary, timestamp: now });
      data.history = history.slice(-20);
      await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
      return summary;
    }

    // ── PHASE: DELIVERY ──
    if (phase === 'delivery') {
      if (!data.fulfilment) {
        let resolved = null;
        if (msg === '1' || msg.includes('deliver')) resolved = 'DELIVERY';
        else if (msg === '2' || msg.includes('pickup') || msg.includes('pick up') || msg.includes('collect')) resolved = 'PICKUP';

        if (!resolved) {
          const allP = await pool.query(
            `SELECT id, name, price, stock_qty, rx_required FROM products WHERE pharmacy_id = $1 AND active = true ORDER BY name ASC`,
            [pharmacyConfig.id]
          );
          const aiResp = await pharmacyAI(message, history.slice(-20), data, allP.rows, pharmacyConfig);
          if (aiResp.extracted?.fulfilment) {
            resolved = aiResp.extracted.fulfilment.toUpperCase();
          } else {
            const reply = aiResp.reply || `How would you like to receive your order? Reply 1 for Delivery or 2 for Pickup.`;
            history.push({ role: 'assistant', content: reply, timestamp: now });
            data.history = history.slice(-20);
            await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
            return reply;
          }
        }

        data.fulfilment = resolved;
        if (resolved === 'PICKUP') {
          data.phase = 'confirm';
          const summary = buildOrderSummary(data, pharmacyConfig);
          history.push({ role: 'assistant', content: summary, timestamp: now });
          data.history = history.slice(-20);
          await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
          return summary;
        }
        const areaQ = `What area should we deliver to?`;
        history.push({ role: 'assistant', content: areaQ, timestamp: now });
        data.history = history.slice(-20);
        await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
        return areaQ;
      }

      if (data.fulfilment === 'DELIVERY' && !data.area) {
        data.area = message.trim();
        data.phase = 'confirm';
        const summary = buildOrderSummary(data, pharmacyConfig);
        history.push({ role: 'assistant', content: summary, timestamp: now });
        data.history = history.slice(-20);
        await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
        return summary;
      }
    }

    // ── PHASE: MORE_OR_CHECKOUT ──
    if (phase === 'more_or_checkout') {
      if (msg === 'clear' || msg === 'clear cart') {
        data.cart = [];
        data.phase = 'product';
        const reply = `Cart cleared. What would you like to order?`;
        history.push({ role: 'assistant', content: reply, timestamp: now });
        data.history = history.slice(-20);
        await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
        return reply;
      }
      if (['checkout', 'done', 'proceed', "that's all", "that's it", 'no more', 'nothing else'].includes(msg)) {
        data.phase = 'delivery';
        data.fulfilment = null;
        data.area = null;
        const delivQ = `How would you like to receive your order?\n\n1. Delivery\n2. Pickup`;
        history.push({ role: 'assistant', content: delivQ, timestamp: now });
        data.history = history.slice(-20);
        await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
        return delivQ;
      }
    }

    // ── PHASE: PRODUCT — server-side qty shortcut ──
    if (phase === 'product' && data.product_id && !data.qty) {
      const n = parseInt(msg);
      if (!isNaN(n) && n >= 1 && n <= 99) {
        const stock = await pool.query('SELECT stock_qty FROM products WHERE id = $1', [data.product_id]);
        const avail = stock.rows[0]?.stock_qty ?? 0;
        if (n > avail) {
          const reply = `We only have ${avail} unit(s) of ${data.product_name} available. How many would you like?`;
          history.push({ role: 'assistant', content: reply, timestamp: now });
          data.history = history.slice(-20);
          await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
          return reply;
        }
        data.qty = n;
        if (data.product_rx_required && data.rx_confirmed === null) {
          data.phase = 'rx_confirm';
          const rxQ = `${data.product_name} requires a valid prescription.\n\nPlease confirm you have a current valid prescription for this item before we continue. Reply yes or no.`;
          history.push({ role: 'assistant', content: rxQ, timestamp: now });
          data.history = history.slice(-20);
          await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
          return rxQ;
        }
        return await addToCartAndPrompt(data, history, phone, pharmacyConfig, now);
      }
    }

    // ── PHASE: RX_CONFIRM ──
    if (phase === 'rx_confirm') {
      const hasRx = ['yes', 'y', 'i have', 'i do', 'have it'].includes(msg) ||
        msg.includes('have a prescription') || msg.includes('have the prescription');
      const noRx = ['no', 'n'].includes(msg) ||
        msg.includes("don't have") || msg.includes("dont have") || msg.includes("i don't");

      if (hasRx) {
        data.rx_confirmed = true;
        data.phase = 'product';
        return await addToCartAndPrompt(data, history, phone, pharmacyConfig, now);
      }
      if (noRx) {
        data.product_id = null; data.product_name = null; data.product_price = null;
        data.product_rx_required = false; data.qty = null; data.rx_confirmed = null;
        data.phase = data.cart.length > 0 ? 'more_or_checkout' : 'product';
        const reply = data.cart.length > 0
          ? `No problem. Your cart has ${data.cart.length} item(s). Type checkout to proceed, or tell me what else you need.`
          : `No problem. What else can I help you find?`;
        history.push({ role: 'assistant', content: reply, timestamp: now });
        data.history = history.slice(-20);
        await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
        return reply;
      }
      const rxRemind = `Do you have a valid prescription for ${data.product_name}? Reply yes or no.`;
      history.push({ role: 'assistant', content: rxRemind, timestamp: now });
      data.history = history.slice(-20);
      await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
      return rxRemind;
    }

    // ── PHARMACY AI CALL ──
    const allProducts = await pool.query(
      `SELECT id, name, price, stock_qty, rx_required FROM products WHERE pharmacy_id = $1 AND active = true ORDER BY name ASC`,
      [pharmacyConfig.id]
    );
    const aiResp = await pharmacyAI(message, history.slice(-20), data, allProducts.rows, pharmacyConfig);

    // ── PRODUCT NAME EXTRACTION → server fuzzy match ──
    if (aiResp.extracted?.product_name_mentioned && !data.product_id) {
      const inStock = allProducts.rows.filter(p => p.stock_qty > 0);
      const matched = fuzzyMatchProducts(aiResp.extracted.product_name_mentioned, inStock);

      if (matched.length === 0) {
        const alts = allProducts.rows.filter(p => p.stock_qty > 0).slice(0, 6);
        let reply;
        if (alts.length === 0) {
          reply = `Sorry, we don't currently have that or any in-stock alternatives. Please check back soon.`;
        } else {
          const altList = alts.map(p => `${p.name} — ${formatCurrency(p.price, currency)}`).join('\n');
          reply = `Sorry, we don't have "${aiResp.extracted.product_name_mentioned}" in stock.\n\nHere is what we currently have:\n\n${altList}\n\nWould you like any of these?`;
        }
        history.push({ role: 'assistant', content: reply, timestamp: now });
        data.history = history.slice(-20);
        await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
        return reply;
      }

      const best = matched[0];
      // price and rx_required come from DB — never from the LLM
      data.product_id = best.id;
      data.product_name = best.name;
      data.product_price = parseFloat(best.price);
      data.product_rx_required = best.rx_required || false;
      data.phase = 'product';

      const confirmReply = `We have ${best.name} — ${formatCurrency(best.price, currency)} each.\n\nHow many would you like?`;
      history.push({ role: 'assistant', content: confirmReply, timestamp: now });
      data.history = history.slice(-20);
      await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
      return confirmReply;
    }

    // ── QTY EXTRACTION from AI ──
    if (aiResp.extracted?.qty && data.product_id && !data.qty) {
      const n = parseInt(aiResp.extracted.qty);
      if (!isNaN(n) && n >= 1 && n <= 99) {
        const stock = await pool.query('SELECT stock_qty FROM products WHERE id = $1', [data.product_id]);
        const avail = stock.rows[0]?.stock_qty ?? 0;
        if (n > avail) {
          const reply = `We only have ${avail} unit(s) of ${data.product_name} available. How many would you like?`;
          history.push({ role: 'assistant', content: reply, timestamp: now });
          data.history = history.slice(-20);
          await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
          return reply;
        }
        data.qty = n;
        if (data.product_rx_required && data.rx_confirmed === null) {
          data.phase = 'rx_confirm';
          const rxQ = `${data.product_name} requires a valid prescription.\n\nPlease confirm you have a current valid prescription before we continue. Reply yes or no.`;
          history.push({ role: 'assistant', content: rxQ, timestamp: now });
          data.history = history.slice(-20);
          await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
          return rxQ;
        }
        return await addToCartAndPrompt(data, history, phone, pharmacyConfig, now);
      }
    }

    // ── NEW PRODUCT NAMED WHILE IN more_or_checkout ──
    if (aiResp.extracted?.product_name_mentioned && phase === 'more_or_checkout') {
      data.phase = 'product';
      data.product_id = null; data.product_name = null; data.product_price = null;
      data.product_rx_required = false; data.rx_confirmed = null; data.qty = null;
      const inStock = allProducts.rows.filter(p => p.stock_qty > 0);
      const matched = fuzzyMatchProducts(aiResp.extracted.product_name_mentioned, inStock);
      if (matched.length > 0) {
        const best = matched[0];
        data.product_id = best.id;
        data.product_name = best.name;
        data.product_price = parseFloat(best.price);
        data.product_rx_required = best.rx_required || false;
        const confirmReply = `We have ${best.name} — ${formatCurrency(best.price, currency)} each.\n\nHow many would you like?`;
        history.push({ role: 'assistant', content: confirmReply, timestamp: now });
        data.history = history.slice(-20);
        await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
        return confirmReply;
      }
    }

    // ── FALLBACK: use AI reply ──
    const fallback = aiResp.reply || `What product are you looking for? I can help you find it.`;
    history.push({ role: 'assistant', content: fallback, timestamp: now });
    data.history = history.slice(-20);
    await updatePharmacyConversation(phone, pharmacyConfig.id, 'ACTIVE', data);
    return fallback;
  }

  return `Welcome to ${pharmacyConfig.pharmacy_name}. Send a message to get started.`;
}

// ─── META WEBHOOK VERIFICATION ────────────────────────
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    addLog('info', 'Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── META WEBHOOK — INCOMING MESSAGES ─────────────────
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (!body.object || body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    if (!value?.messages?.[0]) return;

    const msg = value.messages[0];
    const phone = msg.from;

    // Extract text or media attachment (images/PDFs — used for prescription uploads)
    const message         = msg.text?.body || null;
    const mediaId         = msg.image?.id       || msg.document?.id       || null;
    const mediaMime       = msg.image?.mime_type || msg.document?.mime_type || null;
    const mediaFilename   = msg.document?.filename || (msg.image ? `prescription_${Date.now()}.jpg` : null);
    const mediaAttachment = mediaId ? { mediaId, mediaMime, mediaFilename } : null;

    // Need at least a text body or a media attachment
    if (!phone || (!message && !mediaAttachment)) return;

    if (!msg.id || isAlreadyProcessed(msg.id)) {
      addLog('info', 'Duplicate webhook ignored', msg.id);
      return;
    }

    const incomingPhoneNumberId = value.metadata?.phone_number_id;
    const tenant = await resolveTenant(incomingPhoneNumberId);
    addLog('info', `Message from ${phone} [${tenant.business_type}]: ${message || '(media)'}`);

    io.emit('new_message', {
      conversationId: phone,
      message: {
        id: msg.id,
        conversation_id: phone,
        sender: 'PATIENT',
        body: message || '(media attachment)',
        type: mediaAttachment ? 'media' : 'text',
        status: 'delivered',
        timestamp: new Date().toISOString()
      }
    });

    // Kill switch: pharmacy exists but active = false — drop silently
    if (tenant.business_type === 'PHARMACY_INACTIVE') {
      addLog('info', `[INACTIVE] ${tenant.config.pharmacy_name} — message from ${phone} dropped`);
      return;
    }

    let reply;
    if (tenant.business_type === 'PHARMACY') {
      const adapter = loadAdapter(tenant.config, pool);
      reply = await pharmFlow.processPharmacyMessage(phone, message, mediaAttachment, tenant.config, adapter);
      if (reply) await sendWhatsApp(phone, reply, tenant.config.phone_number_id);
    } else {
      reply = await processMessage(phone, message);
      await sendWhatsApp(phone, reply);
    }

    io.emit('new_message', {
      conversationId: phone,
      message: {
        id: `zero_${Date.now()}`,
        conversation_id: phone,
        sender: 'ZERO',
        body: reply,
        type: 'text',
        status: 'delivered',
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    addLog('error', 'Webhook error', error.message);
  }
});

// ─── TWILIO WEBHOOK (SANDBOX TESTING) ────────────────
app.post('/webhook/twilio', async (req, res) => {
  const phone = req.body.From?.replace('whatsapp:', '');
  const message = req.body.Body;
  if (!phone || !message) return res.status(400).send('Missing data');
  try {
    const reply = await processMessage(phone, message);
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`);
  } catch (error) {
    addLog('error', 'Twilio webhook error', error.message);
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Sorry, something went wrong. Please try again.</Message></Response>`);
  }
});

// ─── PAYSTACK PAYMENT WEBHOOK ─────────────────────────
// NOTE: req.rawBody is captured by the express.json verify callback at the top.
// We look up the tenant by payment_ref so each pharmacy's own secret is used.
app.post('/webhook/payment', async (req, res) => {
  // Acknowledge immediately; Paystack retries if it doesn't get 200 fast
  res.sendStatus(200);
  try {
    const signature = req.headers['x-paystack-signature'];
    if (!signature) return;

    const payload = req.body;
    if (!payload || payload.event !== 'charge.success') return;

    const reference = payload.data?.reference;
    if (!reference) return;

    // Resolve the tenant from the order so we use their secret for verification
    const orderRes = await pool.query(
      `SELECT o.id, o.pharmacy_id, o.status,
              p.paystack_secret_key, p.phone_number_id, p.pharmacy_name,
              p.currency, p.delivery_note
       FROM orders o
       JOIN pharmacy_config p ON p.id = o.pharmacy_id
       WHERE o.payment_ref = $1
       LIMIT 1`,
      [reference]
    );
    if (orderRes.rows.length === 0) {
      addLog('warn', 'Paystack webhook: unknown reference', reference);
      return;
    }
    const row = orderRes.rows[0];

    if (!row.paystack_secret_key) {
      addLog('warn', 'Paystack webhook: no secret configured for pharmacy', row.pharmacy_id);
      return;
    }

    if (!verifyPaystackSignature(req.rawBody, signature, row.paystack_secret_key)) {
      addLog('warn', 'Paystack webhook: signature mismatch', reference);
      return;
    }

    if (row.status === 'PAID') return; // idempotent

    const confirmedOrder = await confirmOrderPayment(row.id, reference, row.pharmacy_id);
    if (!confirmedOrder) return; // concurrent request already confirmed it

    await notifyCustomerPaymentConfirmed(confirmedOrder, row);
    io.emit('queue_updated', { type: 'pharmacy_order_paid', orderId: confirmedOrder.id, pharmacyId: confirmedOrder.pharmacy_id });
    addLog('info', `Paystack payment confirmed: ZPHARM-${confirmedOrder.id} | ${row.pharmacy_name}`);
  } catch (e) {
    addLog('error', 'Paystack webhook error', e.message);
  }
});

// ─── ZEROCHAT CONVERSATION ENDPOINTS ──────────────────
app.get('/api/conversations', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT phone, state, data, created_at, updated_at
       FROM conversations
       WHERE state != 'START'
       ORDER BY updated_at DESC`
    );
    const rows = result.rows.map(row => {
      const data = row.data || {};
      const history = data.history || [];
      const last = history.length > 0 ? history[history.length - 1] : null;
      const flagged = data.flagged === true || data.flagged === 'true';
      const aiPaused = data.ai_paused === true || data.ai_paused === 'true';
      return {
        id: row.phone,
        patient_id: null,
        patient_name: data.name || 'Unknown',
        phone_number: row.phone,
        status: row.state === 'DONE' && !flagged ? 'RESOLVED' : 'OPEN',
        flagged,
        flag_reason: data.flag_reason || null,
        is_ai_paused: aiPaused,
        last_message: last?.content || null,
        last_message_at: last?.timestamp || row.updated_at,
        unread_count: 0,
        created_at: row.created_at || row.updated_at,
        updated_at: row.updated_at
      };
    });
    res.json(rows);
  } catch (error) {
    addLog('error', 'GET /api/conversations error', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const conv = await pool.query('SELECT * FROM conversations WHERE phone = $1', [id]);
    if (conv.rows.length === 0) return res.json([]);

    const data = conv.rows[0].data || {};
    const history = data.history || [];

    const senderMap = { assistant: 'ZERO', user: 'PATIENT', patient: 'PATIENT' };
    const messages = history.map((h, i) => ({
      id: `msg_${i}`,
      conversation_id: id,
      sender: senderMap[h.role] || 'PATIENT',
      body: h.content,
      type: 'text',
      status: 'delivered',
      timestamp: h.timestamp || new Date().toISOString()
    }));

    res.json(messages);
  } catch (error) {
    addLog('error', 'GET /api/conversations/:id/messages error', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/conversations/:id/reply', async (req, res) => {
  try {
    const { id } = req.params;
    const { body } = req.body;
    await sendWhatsApp(id, body);
    const message = {
      id: `staff_${Date.now()}`,
      conversation_id: id,
      sender: 'HUMAN',
      body,
      type: 'text',
      status: 'delivered',
      timestamp: new Date().toISOString()
    };
    io.emit('new_message', { conversationId: id, message });
    res.json(message);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/conversations/:id/resolve', async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await pool.query(
      `UPDATE conversations SET data = jsonb_set(COALESCE(data, '{}'), '{flagged}', 'false'), updated_at = NOW() WHERE phone = $1 RETURNING *`,
      [id]
    );
    const row = updated.rows[0] || {};
    const data = row.data || {};
    const history = data.history || [];
    const last = history.length > 0 ? history[history.length - 1] : null;
    const conversation = {
      id, patient_id: null, patient_name: data.name || 'Unknown', phone_number: id,
      status: 'RESOLVED', flagged: false, flag_reason: null,
      is_ai_paused: data.ai_paused === true || data.ai_paused === 'true',
      last_message: last?.content || null, last_message_at: last?.timestamp || row.updated_at,
      unread_count: 0, created_at: row.created_at || row.updated_at, updated_at: row.updated_at
    };
    io.emit('conversation_updated', { conversation });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/conversations/:id/ai-pause', async (req, res) => {
  try {
    const { id } = req.params;
    const { paused } = req.body;
    await pool.query(
      `UPDATE conversations SET data = jsonb_set(COALESCE(data, '{}'), '{ai_paused}', $1::jsonb), updated_at = NOW() WHERE phone = $2`,
      [JSON.stringify(paused), id]
    );
    io.emit('ai_paused', { conversationId: id, paused });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── PATIENT & QUEUE ENDPOINTS ────────────────────────
app.get('/api/patients/active', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM patients WHERE DATE(created_at) = CURRENT_DATE AND status = 'waiting' ORDER BY queue_number ASC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const STATUS_UP = { waiting: 'WAITING', with_doctor: 'WITH_DOCTOR', seen: 'DONE', done: 'DONE', arrived: 'ARRIVED', missed: 'MISSED', cancelled: 'CANCELLED', booked: 'BOOKED' };
const URGENCY_UP = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH', critical: 'CRITICAL' };
function normalizePatient(p) {
  return {
    ...p,
    phone_number: p.phone,
    status: STATUS_UP[p.status?.toLowerCase()] || (p.status?.toUpperCase() ?? 'WAITING'),
    urgency: URGENCY_UP[p.urgency?.toLowerCase()] || (p.urgency?.toUpperCase() ?? 'LOW'),
    patient_type: 'WALK_IN',
    consultation_mode: 'PHYSICAL',
    arrival_timestamp: p.created_at,
  };
}

app.get('/api/patients', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM patients WHERE DATE(created_at) = CURRENT_DATE ORDER BY queue_number ASC`
    );
    res.json(result.rows.map(normalizePatient));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/queue', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM patients WHERE DATE(created_at) = CURRENT_DATE AND status = 'waiting' ORDER BY queue_number ASC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats/today', async (req, res) => {
  try {
    const total = await pool.query(`SELECT COUNT(*) FROM patients WHERE DATE(created_at) = CURRENT_DATE`);
    const waiting = await pool.query(`SELECT COUNT(*) FROM patients WHERE DATE(created_at) = CURRENT_DATE AND status = 'waiting'`);
    const seen = await pool.query(`SELECT COUNT(*) FROM patients WHERE DATE(created_at) = CURRENT_DATE AND status = 'seen'`);
    const withDoctor = await pool.query(`SELECT COUNT(*) FROM patients WHERE DATE(created_at) = CURRENT_DATE AND status = 'with_doctor'`);
    const appointments = await pool.query(`SELECT COUNT(*) FROM appointments WHERE DATE(created_at) = CURRENT_DATE`);
    const avgWait = await pool.query(
      `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/60)) as avg_minutes
       FROM patients WHERE DATE(created_at) = CURRENT_DATE AND status = 'seen'`
    );
    res.json({
      total_today: parseInt(total.rows[0].count),
      waiting: parseInt(waiting.rows[0].count),
      with_doctor: parseInt(withDoctor.rows[0].count),
      completed: parseInt(seen.rows[0].count),
      appointments: parseInt(appointments.rows[0].count),
      avg_wait_minutes: parseInt(avgWait.rows[0].avg_minutes) || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/patients/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, generate_queue } = req.body;
  const validStatuses = ['waiting', 'seen', 'done', 'cancelled', 'with_doctor', 'WAITING', 'DONE', 'WITH_DOCTOR', 'ARRIVED', 'MISSED', 'CANCELLED'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    let dbStatus = status.toLowerCase();
    let result;
    if (generate_queue) {
      const queueNumber = await getNextQueueNumber();
      result = await pool.query(
        `UPDATE patients SET status = 'waiting', queue_number = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [queueNumber, id]
      );
    } else {
      result = await pool.query(
        `UPDATE patients SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [dbStatus, id]
      );
    }
    if (result.rows.length === 0) return res.status(404).json({ error: 'Patient not found' });
    const patient = normalizePatient(result.rows[0]);
    io.emit('queue_updated', { type: 'status_change', patient });
    res.json(patient);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/queue/next', async (req, res) => {
  try {
    const config = await getConfig();
    const current = await pool.query(
      `SELECT * FROM patients WHERE status = 'waiting' ORDER BY queue_number ASC LIMIT 1`
    );
    if (current.rows.length === 0) {
      return res.json({ success: false, message: 'No patients in queue', next: null });
    }
    const updated = await pool.query(
      `UPDATE patients SET status = 'with_doctor', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [current.rows[0].id]
    );
    await sendWhatsApp(current.rows[0].phone,
      `*Hi ${current.rows[0].name}.* It's your turn.\n\nPlease proceed to the consultation room. The doctor is ready for you.\n\n_— Zero_`
    );
    const patient = normalizePatient(updated.rows[0]);
    io.emit('queue_updated', { type: 'next', patient });
    res.json({ success: true, patient });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/appointments', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM appointments ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── ADMIN ENDPOINTS (LatencyZero internal) ───────────

app.get('/api/admin/health', adminAuth, async (req, res) => {
  const health = {
    status: 'ok',
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    db: 'ok',
    environment: {
      has_gemini_key: !!process.env.GEMINI_API_KEY,
      has_meta_token: !!process.env.META_ACCESS_TOKEN,
      has_db_url: !!process.env.DATABASE_URL
    }
  };
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    health.db = 'fail';
    health.status = 'degraded';
  }
  res.json(health);
});

app.get('/api/admin/overview', adminAuth, async (req, res) => {
  try {
    const patients = await pool.query(`SELECT COUNT(*) FROM patients`);
    const appointments = await pool.query(`SELECT COUNT(*) FROM appointments`);
    const conversations = await pool.query(`SELECT COUNT(*) FROM conversations WHERE state != 'START'`);
    const active = await pool.query(`SELECT COUNT(*) FROM conversations WHERE state = 'ACTIVE'`);
    const done = await pool.query(`SELECT COUNT(*) FROM conversations WHERE state = 'DONE'`);
    const today = await pool.query(`SELECT COUNT(*) FROM patients WHERE DATE(created_at) = CURRENT_DATE`);
    res.json({
      total_patients: parseInt(patients.rows[0].count),
      total_appointments: parseInt(appointments.rows[0].count),
      total_conversations: parseInt(conversations.rows[0].count),
      active_conversations: parseInt(active.rows[0].count),
      completed_conversations: parseInt(done.rows[0].count),
      patients_today: parseInt(today.rows[0].count),
      uptime_seconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/conversations', adminAuth, async (req, res) => {
  try {
    const { state, search } = req.query;
    let query = `SELECT phone as id, phone, state, data,
      COALESCE(data->>'name', 'Unknown') as patient_name,
      updated_at,
      jsonb_array_length(COALESCE(data->'history', '[]'::jsonb)) as message_count
      FROM conversations WHERE 1=1`;
    const params = [];
    if (state) {
      params.push(state.toUpperCase());
      query += ` AND state = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (phone ILIKE $${params.length} OR data->>'name' ILIKE $${params.length})`;
    }
    query += ` ORDER BY updated_at DESC LIMIT 200`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/admin/conversations/:id/reset', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      `UPDATE conversations SET state = 'START', data = '{}', updated_at = NOW() WHERE phone = $1`,
      [id]
    );
    addLog('info', `Admin reset conversation: ${id}`);
    res.json({ success: true, message: `Conversation ${id} reset to START` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/admin/conversations/:id/state', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { state, data } = req.body;
    await pool.query(
      `UPDATE conversations SET state = $1, data = $2, updated_at = NOW() WHERE phone = $3`,
      [state, JSON.stringify(data || {}), id]
    );
    addLog('info', `Admin override conversation ${id} → state: ${state}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// FIX: was using `key` (undefined) instead of `k` — corrected
app.patch('/api/admin/clinic', adminAuth, async (req, res) => {
  try {
    const fields = req.body;
    const allowedFields = ['clinic_name', 'agent_name', 'receptionist_whatsapp', 'doctor_whatsapp', 'services'];
    const updates = Object.keys(fields).filter(k => allowedFields.includes(k));
    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields provided' });

    const setClauses = updates.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = updates.map(k => fields[k]);
    await pool.query(`UPDATE clinic_config SET ${setClauses} WHERE id = 1`, values);

    addLog('info', 'Admin updated clinic config', JSON.stringify(updates));
    const updated = await pool.query('SELECT * FROM clinic_config LIMIT 1');
    res.json({ success: true, config: updated.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/message', adminAuth, async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'to and message required' });
    await sendWhatsApp(to, message);
    addLog('info', `Admin sent message to ${to}`);
    res.json({ success: true, to, message });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/logs', adminAuth, (req, res) => {
  const { level } = req.query;
  const logs = level ? errorLog.filter(l => l.level === level) : errorLog;
  res.json({ count: logs.length, logs });
});

// ─── METRICS ENDPOINTS ────────────────────────────────

app.get('/api/metrics/impact', adminAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;

    const [
      totalPatients, totalAppointments, todayPatients, todayAppointments,
      avgWait, byDepartment, byUrgency, dailyTrend, busiestHours, convStats
    ] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM patients`),
      pool.query(`SELECT COUNT(*) FROM appointments`),
      pool.query(`SELECT COUNT(*) FROM patients WHERE DATE(created_at) = CURRENT_DATE`),
      pool.query(`SELECT COUNT(*) FROM appointments WHERE DATE(created_at) = CURRENT_DATE`),
      pool.query(`SELECT ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/60)) as avg_minutes FROM patients WHERE status = 'seen'`),
      pool.query(`SELECT department, COUNT(*) as count FROM patients GROUP BY department ORDER BY count DESC`),
      pool.query(`SELECT urgency, COUNT(*) as count FROM patients WHERE urgency IS NOT NULL GROUP BY urgency ORDER BY count DESC`),
      pool.query(`SELECT DATE(created_at) as date, COUNT(*) as count FROM patients WHERE created_at >= NOW() - INTERVAL '${days} days' GROUP BY DATE(created_at) ORDER BY date ASC`),
      pool.query(`SELECT EXTRACT(HOUR FROM created_at)::int as hour, COUNT(*) as count FROM patients GROUP BY hour ORDER BY count DESC LIMIT 5`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE state != 'START') as total_started, COUNT(*) FILTER (WHERE state = 'DONE') as completed, ROUND(AVG(jsonb_array_length(COALESCE(data->'history', '[]'::jsonb)))) as avg_messages FROM conversations`)
    ]);

    const totalP = parseInt(totalPatients.rows[0].count);
    const convRow = convStats.rows[0];
    const totalStarted = parseInt(convRow.total_started) || 0;
    const completed = parseInt(convRow.completed) || 0;
    const completionRate = totalStarted > 0 ? Math.round((completed / totalStarted) * 1000) / 10 : 0;
    const estimatedMinutesSaved = totalP * 5;

    res.json({
      period_days: days,
      generated_at: new Date().toISOString(),
      patients: {
        total: totalP,
        today: parseInt(todayPatients.rows[0].count),
        by_department: byDepartment.rows.reduce((acc, r) => ({ ...acc, [r.department]: parseInt(r.count) }), {}),
        by_urgency: byUrgency.rows.reduce((acc, r) => ({ ...acc, [r.urgency]: parseInt(r.count) }), {}),
        daily_trend: dailyTrend.rows.map(r => ({ date: r.date, count: parseInt(r.count) })),
        busiest_hours: busiestHours.rows.map(r => ({ hour: r.hour, count: parseInt(r.count) }))
      },
      appointments: {
        total: parseInt(totalAppointments.rows[0].count),
        today: parseInt(todayAppointments.rows[0].count)
      },
      efficiency: {
        avg_wait_minutes: parseInt(avgWait.rows[0].avg_minutes) || 0,
        avg_messages_per_conversation: parseInt(convRow.avg_messages) || 0,
        estimated_minutes_saved: estimatedMinutesSaved,
        estimated_hours_saved: Math.round((estimatedMinutesSaved / 60) * 10) / 10
      },
      zero_performance: {
        total_conversations: totalStarted,
        completed,
        completion_rate_pct: completionRate,
        avg_messages_per_conversation: parseInt(convRow.avg_messages) || 0
      }
    });
  } catch (error) {
    addLog('error', 'Metrics impact error', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/metrics/zero-performance', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE state != 'START') as total_started,
         COUNT(*) FILTER (WHERE state = 'DONE') as completed,
         COUNT(*) FILTER (WHERE state = 'ACTIVE') as in_progress,
         COUNT(*) FILTER (WHERE state = 'MENU') as at_menu,
         ROUND(AVG(jsonb_array_length(COALESCE(data->'history', '[]'::jsonb)))) as avg_messages,
         COUNT(*) FILTER (WHERE data->>'flagged' = 'true') as flagged
       FROM conversations`
    );
    const row = result.rows[0];
    const totalStarted = parseInt(row.total_started) || 0;
    const completed = parseInt(row.completed) || 0;
    res.json({
      total_started: totalStarted,
      completed,
      in_progress: parseInt(row.in_progress),
      dropped_at_menu: parseInt(row.at_menu),
      completion_rate_pct: totalStarted > 0 ? Math.round((completed / totalStarted) * 1000) / 10 : 0,
      avg_messages_per_conversation: parseInt(row.avg_messages) || 0,
      flagged_conversations: parseInt(row.flagged)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── PHARMACY: MANUAL PAYMENT CONFIRM ─────────────────
// Dashboard action for manual-provider pharmacies. Runs the same
// confirmOrderPayment transaction as the Paystack webhook.
app.post('/api/pharmacy/orders/:orderId/confirm-payment', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  if (isNaN(orderId)) return res.status(400).json({ error: 'Invalid order ID' });

  try {
    const orderRes = await pool.query(
      `SELECT o.*, p.phone_number_id, p.pharmacy_name, p.currency, p.delivery_note
       FROM orders o
       JOIN pharmacy_config p ON p.id = o.pharmacy_id
       WHERE o.id = $1`,
      [orderId]
    );
    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const row = orderRes.rows[0];

    if (row.status === 'PAID') return res.status(409).json({ error: 'Order already paid' });

    const paymentRef = req.body?.payment_ref || `MANUAL-${orderId}-${Date.now()}`;
    const confirmedOrder = await confirmOrderPayment(orderId, paymentRef, row.pharmacy_id);
    if (!confirmedOrder) return res.status(409).json({ error: 'Order already paid or not found' });

    await notifyCustomerPaymentConfirmed(confirmedOrder, row);
    io.emit('queue_updated', { type: 'pharmacy_order_paid', orderId: confirmedOrder.id, pharmacyId: confirmedOrder.pharmacy_id });
    addLog('info', `Manual payment confirmed: ZPHARM-${orderId} | ${row.pharmacy_name}`);
    res.json({ success: true, order: confirmedOrder });
  } catch (e) {
    addLog('error', 'Manual payment confirm error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── PHARMACY ORDERS API ──────────────────────────────

const ORDER_ITEMS_AGG = `
  COALESCE(
    json_agg(
      json_build_object(
        'id', oi.id, 'product_id', oi.product_id,
        'name_snap', oi.name_snap, 'price_snap', oi.price_snap::float, 'qty', oi.qty
      ) ORDER BY oi.id
    ) FILTER (WHERE oi.id IS NOT NULL),
    '[]'
  ) AS items`;

app.get('/api/pharmacy/:pharmacyId/orders', async (req, res) => {
  try {
    const { pharmacyId } = req.params;
    const result = await pool.query(
      `SELECT o.*, ${ORDER_ITEMS_AGG}
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.pharmacy_id = $1 AND o.status != 'CANCELLED'
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [pharmacyId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/pharmacy/orders/:orderId/status', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const { status } = req.body;
  const VALID = ['FULFILLING', 'DISPATCHED', 'DONE', 'CANCELLED'];
  if (!VALID.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  try {
    const orderRes = await pool.query(
      `SELECT o.*, p.phone_number_id, p.pharmacy_name, p.currency, p.delivery_note
       FROM orders o JOIN pharmacy_config p ON p.id = o.pharmacy_id
       WHERE o.id = $1`,
      [orderId]
    );
    if (!orderRes.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderRes.rows[0];
    if (order.status === status) return res.json({ order }); // idempotent

    if (status === 'CANCELLED') {
      // Restore inventory only if stock was already decremented (PAID or beyond)
      const paidStatuses = ['PAID', 'FULFILLING', 'DISPATCHED'];
      if (paidStatuses.includes(order.status)) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`UPDATE orders SET status = 'CANCELLED' WHERE id = $1`, [orderId]);
          const items = await client.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
          for (const item of items.rows) {
            await client.query(
              `UPDATE products SET stock_qty = stock_qty + $1 WHERE id = $2`,
              [item.qty, item.product_id]
            );
            await client.query(
              `INSERT INTO inventory_log (product_id, change, reason, order_id) VALUES ($1, $2, 'RETURN', $3)`,
              [item.product_id, item.qty, orderId]
            );
          }
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK'); throw e;
        } finally { client.release(); }
      } else {
        await pool.query(`UPDATE orders SET status = 'CANCELLED' WHERE id = $1`, [orderId]);
      }
    } else {
      await pool.query(`UPDATE orders SET status = $1 WHERE id = $2`, [status, orderId]);
    }

    const updated = await pool.query(
      `SELECT o.*, ${ORDER_ITEMS_AGG}
       FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.id = $1 GROUP BY o.id`,
      [orderId]
    );
    io.emit('queue_updated', {
      type: 'pharmacy_order_status',
      orderId,
      status,
      pharmacyId: order.pharmacy_id
    });
    addLog('info', `Order ${orderId} → ${status}`);
    res.json({ order: updated.rows[0] });
  } catch (e) {
    addLog('error', 'Order status update error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── PHARMACY INVENTORY API ───────────────────────────

app.get('/api/pharmacy/:pharmacyId/products', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM products WHERE pharmacy_id = $1 ORDER BY name ASC`,
      [req.params.pharmacyId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/pharmacy/products/:productId', async (req, res) => {
  const { productId } = req.params;
  const { price, active } = req.body;
  const sets = []; const vals = [];
  if (price !== undefined) { sets.push(`price = $${vals.length + 1}`); vals.push(price); }
  if (active !== undefined) { sets.push(`active = $${vals.length + 1}`); vals.push(active); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(productId);
  try {
    const result = await pool.query(
      `UPDATE products SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json({ product: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pharmacy/products/:productId/stock', async (req, res) => {
  const { productId } = req.params;
  const { change, reason } = req.body;
  if (typeof change !== 'number' || !['RESTOCK', 'ADJUST'].includes(reason)) {
    return res.status(400).json({ error: 'change (number) and reason (RESTOCK|ADJUST) required' });
  }
  try {
    const result = await pool.query(
      `UPDATE products SET stock_qty = GREATEST(stock_qty + $1, 0) WHERE id = $2 RETURNING *`,
      [change, productId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
    await pool.query(
      `INSERT INTO inventory_log (product_id, change, reason) VALUES ($1, $2, $3)`,
      [productId, change, reason]
    );
    res.json({ product: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WEB CHANNEL ─────────────────────────────────────────────────────────────
// Primary channel for the pharmacy widget. Reuses the pharmacyFlow state
// machine (same as WhatsApp). Tenant identified by widget_key; identityToken
// verified server-side via adapter.verifyIdentity.

const RX_UPLOAD = multer({
  storage   : multer.memoryStorage(),
  limits    : { fileSize: 10 * 1024 * 1024 }, // 10 MB hard limit
  fileFilter(_req, file, cb) {
    const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
    if (ALLOWED.has(file.mimetype)) return cb(null, true);
    const err = new Error('Only JPEG, PNG, WebP images and PDFs are accepted.');
    err.code = 'INVALID_TYPE';
    cb(err);
  },
});

// Resolve a pharmacy tenant by its public widget key.
async function resolveByWidgetKey(widgetKey) {
  const res = await pool.query(
    'SELECT * FROM pharmacy_config WHERE widget_key = $1 LIMIT 1',
    [widgetKey]
  );
  return res.rows[0] || null;
}

// Build widget action hints from the post-processing conversation state.
// Actions tell the widget UI what controls to render after each reply.
function buildWebActions(state, config) {
  const actions = [];

  // Prescription upload button — shown whenever the flow is waiting for a file
  if (state?.machine === 'ACTIVE' && state.phase === 'rx_confirm') {
    actions.push({
      type  : 'request_attachment',
      accept: 'image/jpeg,image/png,image/webp,application/pdf',
      maxMB : 10,
      label : 'Send Prescription',
    });
  }

  // WhatsApp handoff deep-link — always surfaced when a number is configured
  if (config.handoff_number) {
    actions.push({
      type : 'whatsapp_handoff',
      url  : `https://wa.me/${config.handoff_number.replace(/[^0-9]/g, '')}`,
      label: 'Chat on WhatsApp',
    });
  }

  return actions;
}

// POST /api/web/message
// multipart/form-data: { widgetKey, conversationId?, identityToken?, intent?, text, attachment? }
// Returns: { conversationId, reply, actions }
app.post('/api/web/message',
  // Inline multer error handler so attachment errors return JSON (not Express default HTML)
  (req, res, next) => {
    RX_UPLOAD.single('attachment')(req, res, err => {
      if (!err) return next();
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const msg    = err.code === 'LIMIT_FILE_SIZE'
        ? 'Attachment too large. Maximum allowed size is 10 MB.'
        : (err.message || 'Invalid attachment.');
      res.status(status).json({ error: msg });
    });
  },
  async (req, res) => {
    try {
      const { widgetKey, conversationId, identityToken, intent, text } = req.body;
      const file = req.file || null;

      // ── Validate required fields ──
      if (!widgetKey) return res.status(400).json({ error: 'widgetKey is required.' });
      if (!text && !file) return res.status(400).json({ error: 'text or attachment is required.' });

      // ── Resolve + validate tenant ──
      const config = await resolveByWidgetKey(widgetKey);
      if (!config) return res.status(404).json({ error: 'Unknown pharmacy.' });
      if (!config.active) return res.status(403).json({ error: 'This pharmacy is not currently active.' });

      // ── Load adapter for this tenant ──
      const adapter = loadAdapter(config, pool);

      // ── Resolve identity ──
      // Identified: identityToken → adapter.verifyIdentity (server-side, service role)
      // Guest: use client-supplied conversationId, or generate a new UUID
      let externalUserId = conversationId || crypto.randomUUID();

      let resolvedIdentity = null;
      if (identityToken) {
        try {
          resolvedIdentity = await adapter.verifyIdentity(identityToken);
          if (resolvedIdentity?.externalUserId) externalUserId = resolvedIdentity.externalUserId;
        } catch (e) {
          // Invalid/expired token — treat as guest; do not abort the request
          addLog('warn', 'web identityToken verification failed', e.message);
        }
      }

      // ── Build media attachment from multer buffer (no Meta download needed) ──
      const mediaAttachment = file ? {
        buffer       : file.buffer,
        mediaMime    : file.mimetype,
        mediaFilename: file.originalname || `attachment_${Date.now()}`,
      } : null;

      // ── Synthesize menu selection from intent hint when no text is provided ──
      // Lets the widget skip the MENU step programmatically (e.g. an "Order Now" button)
      const INTENT_MENU = { order: '1', consultation: '2', enquiry: '3' };
      const effectiveText = text || (intent && INTENT_MENU[intent]) || null;

      // ── Run pharmacy flow ──
      const reply = await pharmFlow.processPharmacyMessage(
        externalUserId, effectiveText, mediaAttachment, config, adapter, resolvedIdentity
      );

      // ── Build widget action hints from the saved post-processing state ──
      const state   = await pharmFlow.getConvState(externalUserId, config.id);
      const actions = buildWebActions(state, config);

      res.json({ conversationId: externalUserId, reply, actions });
    } catch (e) {
      addLog('error', 'POST /api/web/message', e.message);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }
);

// POST /api/web/handoff
// Body: { widgetKey, conversationId? }
// Flags the conversation for staff review in the dashboard, and returns a
// wa.me deep-link so the customer can escalate directly on WhatsApp.
// status 'HANDOFF' is an informal extension of the lifecycle values in
// pharmacy_conversations; there is no CHECK constraint on that column.
app.post('/api/web/handoff', async (req, res) => {
  try {
    const { widgetKey, conversationId } = req.body;

    if (!widgetKey) return res.status(400).json({ error: 'widgetKey is required.' });

    const config = await resolveByWidgetKey(widgetKey);
    if (!config) return res.status(404).json({ error: 'Unknown pharmacy.' });

    // Flag the conversation in the DB so the dashboard highlights it
    let flagged = false;
    if (conversationId) {
      const upd = await pool.query(
        `UPDATE pharmacy_conversations
         SET status = 'HANDOFF', updated_at = NOW()
         WHERE external_user_id = $1 AND pharmacy_id = $2
         RETURNING id`,
        [conversationId, config.id]
      );
      flagged = upd.rows.length > 0;
      if (flagged) {
        io.emit('queue_updated', {
          type          : 'pharmacy_handoff',
          pharmacyId    : config.id,
          conversationId,
        });
        addLog('info', `Handoff flagged: ${conversationId} | ${config.pharmacy_name}`);
      }
    }

    const waLink = config.handoff_number
      ? `https://wa.me/${config.handoff_number.replace(/[^0-9]/g, '')}`
      : null;

    res.json({ flagged, whatsapp_link: waLink });
  } catch (e) {
    addLog('error', 'POST /api/web/handoff', e.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'LatencyZero Clinic API running', version: '3.1.0' });
});

// ─── START SERVER ─────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  addLog('info', `Clinic API running on port ${PORT}`);
  addLog('info', 'Socket.io ready');
  addLog('info', 'Meta webhook: /webhook/whatsapp');
  addLog('info', 'Admin endpoints: /api/admin/*');
  addLog('info', 'Metrics endpoints: /api/metrics/*');
});