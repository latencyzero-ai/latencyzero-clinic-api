require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
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
async function sendWhatsApp(to, message) {
  try {
    const cleanPhone = to.replace(/[^0-9]/g, '');
    await axios.post(
      `${META_API}/${PHONE_NUMBER_ID}/messages`,
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

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: systemPrompt,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.3,
      maxOutputTokens: 500,
    }
  });

  const mapped = history.map(h => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.content }]
  }));
  const firstUser = mapped.findIndex(t => t.role === 'user');
  const contents = firstUser >= 0
    ? mapped.slice(firstUser)
    : [{ role: 'user', parts: [{ text: message }] }];

  // ── FIX: wrapped in try/catch with safe JSON parsing ──
  let rawText = '';
  try {
    const result = await model.generateContent({ contents });
    rawText = result.response.text();

    // Strip markdown fences if Gemini wraps the JSON (happens intermittently)
    rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    const parsed = JSON.parse(rawText);

    // Validate the shape — if the model returns garbage, throw so we fallback cleanly
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Invalid JSON shape from Gemini');
    }

    return parsed;

  } catch (e) {
    addLog('error', 'Gemini zeroAI parse/call error', `${e.message} | raw: ${rawText.slice(0, 200)}`);
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
  try {
    const routingModel = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 100,
      }
    });
    const prompt = `Patient complaint: "${complaint}". Symptoms: "${symptoms}". Respond ONLY with JSON: {"department": "General/Dental/Cardiology/Neurology", "urgency": "Low/Medium/High", "summary": "one sentence"}`;
    const result = await routingModel.generateContent(prompt);
    return JSON.parse(result.response.text());
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
    const message = msg.text?.body;
    if (!phone || !message) return;

    if (!msg.id || isAlreadyProcessed(msg.id)) {
      addLog('info', 'Duplicate webhook ignored', msg.id);
      return;
    }

    addLog('info', `Message from ${phone}: ${message}`);

    io.emit('new_message', {
      conversationId: phone,
      message: {
        id: msg.id,
        conversation_id: phone,
        sender: 'PATIENT',
        body: message,
        type: 'text',
        status: 'delivered',
        timestamp: new Date().toISOString()
      }
    });

    const reply = await processMessage(phone, message);
    await sendWhatsApp(phone, reply);

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