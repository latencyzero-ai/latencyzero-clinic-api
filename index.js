require('dotenv').config();

const express = require('express');

const cors = require('cors');

const http = require('http');

const { Server } = require('socket.io');

const axios = require('axios');

const { Pool } = require('pg');

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

// ─── IDEMPOTENCY GUARD ────────────────────────────────

// FIX #1: Prevents Meta duplicate webhook events from sending double greetings

const processedMessages = new Map();

function isAlreadyProcessed(messageId) {

  const now = Date.now();

  // Clean entries older than 60 seconds

  for (const [id, ts] of processedMessages) {

    if (now - ts > 60000) processedMessages.delete(id);

  }

  if (processedMessages.has(messageId)) return true;

  processedMessages.set(messageId, now);

  return false;

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

  const result = await pool.query(

    'SELECT * FROM conversations WHERE phone = $1', [phone]

  );

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

  const existing = await pool.query(

    'SELECT * FROM queue WHERE date = $1', [today]

  );

  if (existing.rows.length === 0) {

    await pool.query(

      'INSERT INTO queue (date, last_number) VALUES ($1, 1)', [today]

    );

    return 1;

  }

  const next = existing.rows[0].last_number + 1;

  await pool.query(

    'UPDATE queue SET last_number = $1 WHERE date = $2', [next, today]

  );

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

    console.log('WhatsApp sent to:', cleanPhone);

  } catch (e) {

    console.log('WhatsApp send error:', e.response?.data || e.message);

  }

}

// ─── NOTIFY CLINIC ────────────────────────────────────

async function notifyClinic(type, data, config) {

  const urgencyEmoji = { 'High': '🔴', 'Medium': '🟡', 'Low': '🟢' };

  let clinicMsg = '';

  if (type === 'walkin') {

    clinicMsg =

      `🔔 *New Walk-in Patient*\n\n` +

      `🔢 Queue: *#${data.queueNumber}*\n` +

      `👤 Name: *${data.name}*\n` +

      `🎂 Age: ${data.age} | ${data.gender}\n` +

      `📱 Phone: ${data.phone}\n` +

      `🏥 Department: *${data.department}*\n` +

      `${urgencyEmoji[data.urgency] || '🟢'} Urgency: *${data.urgency}*\n\n` +

      `💬 Complaint: ${data.complaint}\n` +

      `🩺 Symptoms: ${data.symptoms}\n` +

      `📋 Summary: ${data.summary}\n\n` +

      `📊 View Dashboard: ${DASHBOARD_URL}`;

  }

  if (type === 'onmyway') {

    clinicMsg =

      `🚗 *Patient On The Way*\n\n` +

      `👤 Name: *${data.name}*\n` +

      `🎂 Age: ${data.age} | ${data.gender}\n` +

      `📱 Phone: ${data.phone}\n` +

      `🏥 Likely Department: *${data.department}*\n` +

      `${urgencyEmoji[data.urgency] || '🟢'} Urgency: *${data.urgency}*\n\n` +

      `💬 Complaint: ${data.complaint}\n` +

      `📋 Summary: ${data.summary}\n\n` +

      `_Queue number will be assigned on arrival._\n\n` +

      `📊 View Dashboard: ${DASHBOARD_URL}`;

  }

  if (type === 'appointment') {

    clinicMsg =

      `📅 *New Appointment Scheduled*\n\n` +

      `👤 Name: *${data.name}*\n` +

      `🎂 Age: ${data.age} | ${data.gender}\n` +

      `📱 Phone: ${data.phone}\n` +

      `🏥 Department: *${data.department}*\n` +

      `📆 Date: *${data.appointment_date}*\n` +

      `🕐 Time: *${data.appointment_time}*\n\n` +

      `💬 Complaint: ${data.complaint}\n\n` +

      `📊 View Dashboard: ${DASHBOARD_URL}`;

  }

  if (type === 'next') {

    clinicMsg =

      `✅ *Next Patient Ready*\n\n` +

      `🔢 Queue: *#${data.queueNumber}*\n` +

      `👤 Name: *${data.name}*\n` +

      `🏥 Department: *${data.department}*\n` +

      `💬 Complaint: ${data.complaint}\n\n` +

      `_Please call the patient in now._\n\n` +

      `📊 View Dashboard: ${DASHBOARD_URL}`;

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

        `⏰ *Reminder from Zero!*\n\n` +

        `Hi *${appt.name}*! Your appointment at *${cfg.clinic_name}* ` +

        `is in 30 minutes.\n\n` +

        `Are you:\n` +

        `1️⃣ On my way / Already here\n` +

        `2️⃣ Cancel appointment\n\n` +

        `_Please reply so we can prepare for you._`;

      await sendWhatsApp(appt.phone, message);

      await pool.query(

        `UPDATE appointments SET status = 'reminder_sent' WHERE id = $1`,

        [appt.id]

      );

    }

  } catch (e) {

    console.log('Reminder error:', e.message);

  }

}

setInterval(checkAndSendReminders, 5 * 60 * 1000);

// ─── ZERO AI BRAIN ────────────────────────────────────

// FIX #2: Removed duplicate user message from messages array

// FIX #6: Full medical intelligence system prompt

async function zeroAI(message, history, collectedData, config) {

  const systemPrompt = `You are Zero, a warm and medically intelligent clinic assistant for ${config.clinic_name}.

You help patients register through WhatsApp. You have deep clinical knowledge and use it to ask precise, relevant follow-up questions.

CURRENT PATIENT DATA ALREADY COLLECTED:

${JSON.stringify(collectedData)}

YOUR JOB:

Look at what is already collected above. Find what is STILL MISSING. Ask for ONLY the next missing piece.

REQUIRED FIELDS:

- name: patient full name

- age: number (extract from "I'm 45", "45 years old", "age 45" etc.)

- gender: Male/Female/Prefer not to say (accept m/f/1/2/3/male/female)

- complaint: main reason for visit

- symptoms: clinically relevant details specific to their complaint

- appointment_date: ONLY if mode is "appointment"

- appointment_time: ONLY if mode is "appointment"

COLLECTION ORDER:

1. name, age, gender (can be in one message)

2. complaint (what brings them in)

3. symptoms (smart follow-up specific to the complaint — see MEDICAL INTELLIGENCE below)

4. If appointment mode: date then time

5. When all fields collected: set is_complete to true

━━━━━━━━━━━━━━━━━━━━━━━━

MEDICAL INTELLIGENCE

━━━━━━━━━━━━━━━━━━━━━━━━

You understand medical conditions deeply. Use this knowledge to ask the RIGHT follow-up questions for whatever complaint the patient gives.

DENTAL & ORTHODONTIC (braces, alignment, gaps, spacing, crowding, missing teeth):

→ You know: braces are orthodontic devices for teeth alignment — NOT related to toothache

→ Ask: How long have you been considering this? Any pain or sensitivity currently? Upper, lower, or both?

DENTAL PAIN (toothache, cavity, abscess, gum pain, sensitivity):

→ Ask: Which tooth or area? Sharp or dull ache? Constant or triggered by hot/cold? Any swelling?

CARDIAC (chest pain, palpitations, racing heart, shortness of breath):

→ Ask: Is it sharp, crushing, or pressure-like? Does it spread to your arm or jaw? Any sweating or dizziness?

→ Chest pain with radiation = HIGH urgency — flag immediately

MUSCULOSKELETAL (back pain, joint pain, knee pain, shoulder, swelling, sports injury):

→ Ask: Which joint or area exactly? Sudden injury or gradual onset? Any swelling or bruising?

NEUROLOGICAL (headache, migraine, dizziness, numbness, seizure, memory loss):

→ Ask: Where is the headache located? How frequent? Any nausea, visual changes, or light sensitivity?

RESPIRATORY (cough, asthma, breathing difficulty, wheezing, chest tightness):

→ Ask: Dry or productive cough? Any fever? Breathless at rest or only on exertion? How many days?

GASTROINTESTINAL (stomach pain, nausea, vomiting, diarrhea, constipation, bloating):

→ Ask: Where in the abdomen? Any blood? After eating or unrelated? How many days?

DERMATOLOGY (rash, itching, skin lesion, acne, eczema, wound):

→ Ask: Which part of the body? How long? Is it spreading? Any known allergies or triggers?

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

   → "I need braces" = complaint is orthodontic treatment — NOT toothache

   → "I have back pain" = back pain — do NOT call it a spinal condition

4. Ask ONE question at a time — this is WhatsApp, not a form

5. Use the patient's name once you know it

6. Be warm but brief — no long paragraphs

7. If patient seems frustrated: apologize briefly and ask the next question simply

8. Set is_complete = true ONLY when every required field for their mode is filled

9. NOTE: "mode" is already set in collected data — NEVER ask about mode

INTENT DETECTION:

- "doctor_done": message is exactly "done", "next", "next patient", "mark done", "mark complete"

- "restart": message is "restart", "start over", "reset", "menu"

- "check_queue": message is "queue", "check queue", "my number", "queue status"

- "cancel_appointment": patient explicitly says cancel appointment

- "collecting": everything else

RESPOND ONLY WITH THIS JSON:

{

  "reply": "your short warm WhatsApp response",

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

Only include extracted fields you ACTUALLY found in this message. Set is_complete true only when ALL required fields are present in CURRENT PATIENT DATA after merging.`;

  const messages = [

    { role: 'system', content: systemPrompt },

    ...history

    // FIX: Removed duplicate { role: 'user', content: message }

    // The current user message is already in history (pushed before this call)

  ];

  const response = await axios.post(

    'https://api.groq.com/openai/v1/chat/completions',

    {

      model: 'llama-3.3-70b-versatile', // Upgraded from llama-3.1-8b-instant for medical accuracy

      messages,

      max_tokens: 500,

      temperature: 0.3,

      response_format: { type: 'json_object' }

    },

    {

      headers: {

        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,

        'Content-Type': 'application/json'

      }

    }

  );

  return JSON.parse(response.data.choices[0].message.content);

}

// ─── AI ROUTING ───────────────────────────────────────

async function getAIRouting(complaint, symptoms) {

  try {

    const response = await axios.post(

      'https://api.groq.com/openai/v1/chat/completions',

      {

        model: 'llama-3.1-8b-instant',

        messages: [{

          role: 'user',

          content: `Patient complaint: "${complaint}". Symptoms: "${symptoms}".

          Respond ONLY with JSON:

          {"department": "General/Dental/Cardiology/Neurology", "urgency": "Low/Medium/High", "summary": "one sentence"}`

        }],

        max_tokens: 100,

        temperature: 0.1

      },

      { headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' } }

    );

    return JSON.parse(response.data.choices[0].message.content);

  } catch (e) {

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

  console.log('✅ Patient saved to DB:', result.rows[0]); // Added for Railway debugging

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

  return result.rows[0];

}

// ─── BUILD WELCOME MESSAGE ────────────────────────────

function buildWelcome(config, greeting, isReturn = false) {

  const services = config.services || ['General Consultation', 'Dental Care', 'Cardiology', 'Neurology', 'Laboratory Tests'];

  const emojis = ['🏥', '🦷', '❤️', '🧠', '🔬'];

  const serviceList = services.map((s, i) => `${emojis[i] || '⚕️'} ${s}`).join('\n');

  return `${greeting}! 👋 I'm *${config.agent_name}*, your clinic assistant.\n\n` +

    `Welcome${isReturn ? ' back' : ''} to *${config.clinic_name}*!\n\n` +

    `Here are the services we offer:\n${serviceList}\n\n` +

    `How can I help you today?\n\n` +

    `1️⃣ Walk-in registration\n` +

    `2️⃣ Book an appointment\n` +

    `3️⃣ I'm on my way to the clinic\n` +

    `4️⃣ Check my queue status`;

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

  // ── RESTART ──

  if (['restart', 'reset', 'start over', 'menu'].includes(msg)) {

    const welcomeMsg = buildWelcome(config, greeting, true);

    await updateConversation(phone, 'START', {});

    return welcomeMsg;

  }

  // ── FIRST TIME ──

  if (conv.state === 'START') {

    const welcomeMsg = buildWelcome(config, greeting, false);

    history = [{ role: 'assistant', content: welcomeMsg }];

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

        return `Your queue status:\n\n🔢 Queue Number: *#${p.queue_number}*\n🏥 Department: *${p.department}*\n⏳ Status: *Waiting*\n\nPlease remain seated. I'll notify you when it's your turn! 😊`;

      }

      return `You don't have an active queue number yet.\n\nReply *1* for walk-in or *2* to book an appointment.`;

    }

    if (selection) {

      data.mode = selection;

      history.push({ role: 'user', content: message });

      let modeReply = '';

      if (selection === 'walkin') modeReply = `Great! Let's get you registered quickly. 😊\n\nCould you share your *full name, age and gender*?`;

      if (selection === 'appointment') modeReply = `I'll help you book an appointment! 📅\n\nCould you share your *full name, age and gender*?`;

      if (selection === 'onmyway') modeReply = `Got it! Let's take your details so the clinic is ready when you arrive. 🚗\n\nCould you share your *full name, age and gender*?`;

      history.push({ role: 'assistant', content: modeReply });

      data.history = history.slice(-20);

      await updateConversation(phone, 'ACTIVE', data);

      return modeReply;

    }

    // FIX #5: Was re-sending the full welcome. Now sends a short clarify prompt, state stays MENU.

    return `I didn't quite catch that! 😊 Please choose an option:\n\n` +

      `1️⃣ Walk-in registration\n` +

      `2️⃣ Book an appointment\n` +

      `3️⃣ I'm on my way\n` +

      `4️⃣ Check my queue number\n\n` +

      `_(Reply with a number or keyword)_`;

  }

  // ── DONE STATE — patient messaging again after completed flow ──

  // FIX #4 (part 2): Handle returning patients cleanly instead of falling into ACTIVE with stale context

  if (conv.state === 'DONE') {

    const welcomeMsg = buildWelcome(config, greeting, true);

    const freshHistory = [{ role: 'assistant', content: welcomeMsg }];

    data.history = freshHistory;

    await updateConversation(phone, 'MENU', data);

    return welcomeMsg;

  }

  // ── ACTIVE — collecting patient info ──

  history.push({ role: 'user', content: message });

  // Check exact intents

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

        await sendWhatsApp(n.phone, `🔔 *Hi ${n.name}!* It's your turn!\n\nPlease proceed to the consultation room. The doctor is ready for you. 🏥\n\n_— Zero_`);

        await notifyClinic('next', { queueNumber: n.queue_number, name: n.name, department: n.department, complaint: n.complaint }, config);

        io.emit('queue_updated', { type: 'next' });

        return `✅ Patient #${current.rows[0].queue_number} marked as seen.\n\n*Next:* ${n.name} — #${n.queue_number}`;

      }

      io.emit('queue_updated', { type: 'done' });

      return `✅ Patient marked as seen.\n\nNo more patients in queue. 🎉`;

    }

    return `No active patients in the queue.`;

  }

  if (['queue', 'check queue', 'my number', 'queue status'].includes(msg)) {

    const patient = await pool.query('SELECT * FROM patients WHERE phone = $1 AND status = $2', [phone, 'waiting']);

    if (patient.rows.length > 0) {

      const p = patient.rows[0];

      return `Your queue status:\n\n🔢 *#${p.queue_number}*\n🏥 ${p.department}\n⏳ Waiting\n\nI'll notify you when it's your turn! 😊`;

    }

    return `You don't have an active queue number yet.`;

  }

  // ── CALL ZERO AI ──

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

    return `Your appointment has been cancelled${data.name ? ', ' + data.name : ''}. 😊\n\nMessage us anytime to rebook.\n\n_— Zero_`;

  }

  // ── HANDLE COMPLETE INTAKE ──

  if (aiResponse.is_complete) {

    if (!data.name || !data.age || !data.gender) {

      const reply = `Could you share your full name, age and gender?`;

      history.push({ role: 'assistant', content: reply });

      data.history = history.slice(-20);

      await updateConversation(phone, 'ACTIVE', data);

      return reply;

    }

    if (!data.complaint) {

      const reply = `What brings you to the clinic today, ${data.name}?`;

      history.push({ role: 'assistant', content: reply });

      data.history = history.slice(-20);

      await updateConversation(phone, 'ACTIVE', data);

      return reply;

    }

    if (!data.symptoms) {

      const reply = `Can you describe your symptoms in more detail, ${data.name}?`;

      history.push({ role: 'assistant', content: reply });

      data.history = history.slice(-20);

      await updateConversation(phone, 'ACTIVE', data);

      return reply;

    }

    if (data.mode === 'appointment') {

      if (!data.appointment_date) {

        const reply = `What date would you like to come in, ${data.name}?\n_(e.g. "Tomorrow", "Monday", "27th May")_`;

        history.push({ role: 'assistant', content: reply });

        data.history = history.slice(-20);

        await updateConversation(phone, 'ACTIVE', data);

        return reply;

      }

      if (!data.appointment_time) {

        const reply = `And what time works for you?\n_(e.g. "9am", "2pm", "afternoon")_`;

        history.push({ role: 'assistant', content: reply });

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

      const confirmMsg = `✅ *Appointment Confirmed, ${data.name}!*\n\n📅 Date: *${data.appointment_date}*\n🕐 Time: *${data.appointment_time}*\n🏥 Department: *${routing.department}*\n\nPlease arrive 10 minutes early.\n\n_See you soon! — Zero_ 🤖`;

      history.push({ role: 'assistant', content: confirmMsg });

      // FIX #4: Keep history on completion so ZeroChat can display the conversation

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

      const onWayMsg = `✅ *Got it, ${data.name}!*\n\nThe clinic has been notified you're on your way! 🚗\n\n🏥 Likely Department: *${routing.department}*\n\nA queue number will be assigned when you arrive.\n\n_See you soon! — Zero_ 🤖`;

      history.push({ role: 'assistant', content: onWayMsg });

      // FIX #4: Keep history on completion so ZeroChat can display the conversation

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

    const walkinMsg = `✅ *You're all set, ${data.name}!*\n\n🔢 Queue Number: *#${queueNumber}*\n🏥 Department: *${routing.department}*\n${routing.urgency === 'High' ? '🔴' : routing.urgency === 'Medium' ? '🟡' : '🟢'} Urgency: *${routing.urgency}*\n\nPlease take a seat at reception. I'll message you when it's your turn.\n\n_Thank you for your patience! — Zero_ 🤖`;

    history.push({ role: 'assistant', content: walkinMsg });

    // FIX #4: Keep history on completion so ZeroChat can display the conversation

    await updateConversation(phone, 'DONE', { ...data, history: history.slice(-50) });

    return walkinMsg;

  }

  // ── CONTINUE CONVERSATION ──

  history.push({ role: 'assistant', content: aiResponse.reply });

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

    console.log('Webhook verified!');

    return res.status(200).send(challenge);

  }

  res.sendStatus(403);

});

// ─── META WEBHOOK — INCOMING MESSAGES ─────────────────

app.post('/webhook/whatsapp', async (req, res) => {

  // Always respond 200 immediately — Meta requires this

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

    // FIX #1: Idempotency check — drop duplicate webhook events from Meta

    if (!msg.id || isAlreadyProcessed(msg.id)) {

      console.log('Duplicate webhook event ignored:', msg.id);

      return;

    }

    console.log(`Message from ${phone}: ${message}`);

    // Emit to dashboard

    io.emit('new_message', {

      conversationId: phone,

      message: {

        id: msg.id,

        role: 'patient',

        content: message,

        timestamp: new Date().toISOString()

      }

    });

    // Process and reply

    const reply = await processMessage(phone, message);

    // Send reply via Meta API

    await sendWhatsApp(phone, reply);

    // Emit reply to dashboard

    io.emit('new_message', {

      conversationId: phone,

      message: {

        id: `zero_${Date.now()}`,

        role: 'assistant',

        content: reply,

        timestamp: new Date().toISOString()

      }

    });

  } catch (error) {

    console.error('Webhook error:', error.message);

  }

});

// ─── TWILIO WEBHOOK (KEEP FOR SANDBOX TESTING) ───────

app.post('/webhook/twilio', async (req, res) => {

  const phone = req.body.From?.replace('whatsapp:', '');

  const message = req.body.Body;

  if (!phone || !message) return res.status(400).send('Missing data');

  try {

    const reply = await processMessage(phone, message);

    res.set('Content-Type', 'text/xml');

    res.send(`<?xml version="1.0" encoding="UTF-8"?>

      <Response><Message>${reply}</Message></Response>`);

  } catch (error) {

    console.error('Error:', error.message);

    res.set('Content-Type', 'text/xml');

    res.send(`<?xml version="1.0" encoding="UTF-8"?>

      <Response><Message>Sorry, something went wrong. Please try again. 😊\n\n_— Zero_</Message></Response>`);

  }

});

// ─── CONVERSATION ENDPOINTS (FOR ZEROCHAT) ────────────

app.get('/api/conversations', async (req, res) => {

  try {

    const result = await pool.query(

      `SELECT phone as id, phone, state, data,

       COALESCE(data->>'name', 'Unknown') as patient_name,

       CASE WHEN data->>'flagged' = 'true' THEN true ELSE false END as flagged,

       data->>'flag_reason' as flag_reason,

       updated_at

       FROM conversations

       WHERE state != 'START'

       ORDER BY updated_at DESC`

    );

    res.json(result.rows);

  } catch (error) {

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

    const messages = history.map((h, i) => ({

      id: `msg_${i}`,

      role: h.role === 'assistant' ? 'assistant' : 'patient',

      content: h.content,

      timestamp: h.timestamp || new Date().toISOString()

    }));

    res.json(messages);

  } catch (error) {

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

      role: 'assistant',

      content: body,

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

    await pool.query(

      `UPDATE conversations SET data = jsonb_set(COALESCE(data, '{}'), '{flagged}', 'false'), updated_at = NOW() WHERE phone = $1`,

      [id]

    );

    io.emit('conversation_updated', { conversation: { id, flagged: false } });

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

// ─── API ENDPOINTS ────────────────────────────────────

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

app.get('/api/patients', async (req, res) => {

  try {

    const result = await pool.query(

      `SELECT * FROM patients WHERE DATE(created_at) = CURRENT_DATE ORDER BY queue_number ASC`

    );

    res.json(result.rows);

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

app.patch('/api/patients/:id/status', async (req, res) => {

  const { id } = req.params;

  const { status } = req.body;

  const validStatuses = ['waiting', 'seen', 'done', 'cancelled', 'with_doctor', 'WAITING', 'DONE', 'WITH_DOCTOR', 'ARRIVED', 'MISSED', 'CANCELLED'];

  if (!validStatuses.includes(status)) {

    return res.status(400).json({ error: 'Invalid status' });

  }

  try {

    const result = await pool.query(

      `UPDATE patients SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,

      [status.toLowerCase(), id]

    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Patient not found' });

    io.emit('queue_updated', { type: 'status_change', patient: result.rows[0] });

    res.json(result.rows[0]);

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

    await pool.query(

      `UPDATE patients SET status = 'with_doctor', updated_at = NOW() WHERE id = $1`,

      [current.rows[0].id]

    );

    await sendWhatsApp(current.rows[0].phone,

      `🔔 *Hi ${current.rows[0].name}!* It's your turn!\n\nPlease proceed to the consultation room. The doctor is ready for you. 🏥\n\n_— Zero_`

    );

    io.emit('queue_updated', { type: 'next', patient: current.rows[0] });

    res.json({

      success: true,

      message: 'Patient called',

      patient: current.rows[0]

    });

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

app.get('/', (req, res) => {

  res.json({ status: 'LatencyZero Clinic API running 🏥' });

});

// ─── START SERVER ─────────────────────────────────────

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {

  console.log(`Clinic API running on port ${PORT}`);

  console.log(`Socket.io ready`);

  console.log(`Meta webhook: /webhook/whatsapp`);

  console.log(`Twilio webhook: /webhook/twilio`);

});

