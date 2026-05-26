require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

// ─── SEND WHATSAPP ────────────────────────────────────
async function sendWhatsApp(to, message) {
  try {
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
      new URLSearchParams({
        From: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
        To: `whatsapp:${to}`,
        Body: message
      }),
      {
        auth: {
          username: process.env.TWILIO_ACCOUNT_SID,
          password: process.env.TWILIO_AUTH_TOKEN
        }
      }
    );
  } catch (e) {
    console.log('WhatsApp send error:', e.message);
  }
}

// ─── NOTIFY CLINIC ────────────────────────────────────
async function notifyClinic(type, data, config) {
  const urgencyEmoji = { 'High': '🔴', 'Medium': '🟡', 'Low': '🟢' };
  let clinicMsg = '';
  let doctorMsg = '';

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
      `📋 Summary: ${data.summary}`;
    doctorMsg = clinicMsg;
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
      `_Queue number will be assigned on arrival._`;
    doctorMsg = clinicMsg;
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
      `💬 Complaint: ${data.complaint}`;
    doctorMsg = clinicMsg;
  }

  if (type === 'next') {
    clinicMsg =
      `✅ *Next Patient Ready*\n\n` +
      `🔢 Queue: *#${data.queueNumber}*\n` +
      `👤 Name: *${data.name}*\n` +
      `🏥 Department: *${data.department}*\n` +
      `💬 Complaint: ${data.complaint}\n\n` +
      `_Please call the patient in now._`;
    doctorMsg =
      `👨‍⚕️ *Next Patient*\n\n` +
      `🔢 Queue: *#${data.queueNumber}*\n` +
      `👤 ${data.name}\n` +
      `🏥 ${data.department}\n` +
      `💬 ${data.complaint}\n\n` +
      `_Patient has been notified to come in._`;
  }

  if (config.receptionist_whatsapp) {
    await sendWhatsApp(config.receptionist_whatsapp, clinicMsg);
  }
  if (config.doctor_whatsapp && doctorMsg) {
    await sendWhatsApp(config.doctor_whatsapp, doctorMsg);
  }
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

      console.log(`Reminder sent to ${appt.name} — ${appt.phone}`);
    }
  } catch (e) {
    console.log('Reminder error:', e.message);
  }
}

setInterval(checkAndSendReminders, 5 * 60 * 1000);

// ─── ZERO AI BRAIN ────────────────────────────────────
async function zeroAI(message, history, collectedData, config) {
  const systemPrompt = `You are Zero, a warm and intelligent clinic assistant for ${config.clinic_name}.
You help patients register and book appointments through WhatsApp.

CONVERSATION ORDER — STRICTLY FOLLOW THIS SEQUENCE:
Step 1: Collect BASIC DETAILS first (name, age, gender) — ask naturally, can be in one or two messages
Step 2: Collect MEDICAL DETAILS (complaint, symptoms) — ask how they feel, what brought them in
Step 3: ONLY AFTER collecting all medical details — ask HOW they plan to visit:

"How do you plan to visit us today?
1️⃣ I'm already at the clinic
2️⃣ I'm on my way
3️⃣ I'd like to book an appointment"

NEVER ask about visit mode before collecting name, age, gender, complaint and symptoms.

WHAT YOU NEED TO COLLECT:
- name: patient's full name
- age: number only (extract from "I'm 28", "28 years old" etc)
- gender: Male/Female/Prefer not to say (accept m/f/male/female/1/2/3)
- complaint: main reason for visit
- symptoms: detailed description including duration, severity
- mode: HOW they are visiting (collected LAST):
    "walkin" = at the clinic right now
    "onmyway" = coming to clinic soon
    "appointment" = booking for future date
- appointment_date: only if mode is appointment
- appointment_time: only if mode is appointment

ALREADY COLLECTED FROM THIS PATIENT:
${JSON.stringify(collectedData)}

APPOINTMENT ARRIVAL DETECTION:
If a patient says they have arrived, they're here, or they're at the clinic AND they already have an appointment in the system — set mode to "walkin" and is_complete to true so they get a queue number assigned.

APPOINTMENT REMINDER RESPONSE:
If a patient responds to a reminder message saying they're coming or they're here — set mode to "walkin" and is_complete to true.
If they say cancel — set intent to "cancel_appointment".

CRITICAL RULES:
1. Read the FULL conversation history — extract info from ANY previous message
2. NEVER ask for information already collected or mentioned anywhere in history
3. Follow the 3-step sequence strictly — basic details → medical details → visit mode
4. Extract name AND age AND gender from a single message if patient provides them. If patient only gives name, ask specifically for age and gender before moving to medical questions. Do NOT proceed to complaint without age and gender.
5. Use patient's name naturally once you know it
6. Ask for maximum 2 pieces of missing info at a time
7. Keep responses SHORT and friendly — this is WhatsApp not email
8. When you have name + age + gender + complaint + symptoms + mode → IMMEDIATELY set is_complete to TRUE in your JSON response. Do not say "I've taken note" and wait. Complete registration right away.
9. For appointments also need appointment_date + appointment_time before is_complete.
10. Always present the 3 visit mode options clearly when asking about visit type.
11. If mode was already established earlier (patient selected 1, 2, or 3 from the menu) — the moment you have name + age + gender + complaint + symptoms, set is_complete to TRUE immediately. Never leave the patient waiting.
12. Never end a response with a statement like "I've taken note" or "I have your details" without either asking the next question or completing registration.

INTENT DETECTION — ONLY set these for EXACT phrases:
- "doctor_done": ONLY if message is exactly "done", "next", "next patient", "mark done", "mark complete"
- "restart": ONLY if message is "restart", "start over", "reset", "menu"
- "check_queue": ONLY if message is "queue", "check queue", "my number", "queue status"
- "cancel_appointment": ONLY if patient explicitly says cancel their appointment
- "collecting": everything else — normal conversation

DO NOT set doctor_done for phrases like "that's all", "no", "nothing else", "I'm done".

RESPOND ONLY WITH THIS JSON — no other text:
{
  "reply": "your warm friendly WhatsApp response",
  "extracted": {
    "name": null,
    "age": null,
    "gender": null,
    "mode": null,
    "complaint": null,
    "symptoms": null,
    "appointment_date": null,
    "appointment_time": null
  },
  "is_complete": false,
  "intent": "collecting"
}

Only put values in extracted that you ACTUALLY found in the current or previous messages.
Set is_complete to TRUE when you have ALL required fields for the patient's mode.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: message }
  ];

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.1-8b-instant',
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
  return result.rows[0];
}

// ─── SAVE APPOINTMENT ─────────────────────────────────
async function saveAppointment(data, routing) {
  const result = await pool.query(
    `INSERT INTO appointments 
     (phone, name, age, gender, complaint, department, appointment_date, appointment_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [data.phone, data.name, data.age, data.gender,
     data.complaint, routing.department,
     data.appointment_date, data.appointment_time]
  );
  return result.rows[0];
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

  // ─── BUILD WELCOME MESSAGE ────────────────────────
  const buildWelcome = (isReturn = false) => {
    const services = config.services || ['General Consultation', 'Dental Care', 'Cardiology', 'Neurology', 'Laboratory Tests'];
    const emojis = ['🏥', '🦷', '❤️', '🧠', '🔬'];
    const serviceList = services.map((s, i) => `${emojis[i] || '⚕️'} ${s}`).join('\n');
    return `${greeting}! 👋 I'm *${config.agent_name}*, your clinic assistant.\n\n` +
      `Welcome${isReturn ? ' back' : ''} to *${config.clinic_name}*!\n\n` +
      `Here are the services we offer:\n${serviceList}\n\n` +
      `I can help you with:\n` +
      `1️⃣ Walk-in registration\n` +
      `2️⃣ Book an appointment\n` +
      `3️⃣ Let us know you're on your way\n` +
      `4️⃣ Check your queue status\n\n` +
      `How can I help you today?`;
  };

  // ── RESTART ──
  if (['restart', 'reset', 'start over', 'menu'].includes(msg)) {
    const welcomeMsg = buildWelcome(true);
    await updateConversation(phone, 'ACTIVE', { phone, history: [{ role: 'assistant', content: welcomeMsg }] });
    return welcomeMsg;
  }

  // ── FIRST TIME ──
  if (conv.state === 'START') {
    const welcomeMsg = buildWelcome(false);
    history = [{ role: 'assistant', content: welcomeMsg }];
    data.history = history;
    await updateConversation(phone, 'ACTIVE', data);

    const greetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'hii', 'helo'];
    if (greetings.some(g => msg.includes(g)) && msg.length < 20) {
      return welcomeMsg;
    }

    history.push({ role: 'user', content: message });
    const aiResponse = await zeroAI(message, history, data, config);

    if (aiResponse.extracted) {
      Object.keys(aiResponse.extracted).forEach(key => {
        if (aiResponse.extracted[key] !== null && aiResponse.extracted[key] !== undefined) {
          data[key] = aiResponse.extracted[key];
        }
      });
    }

    history.push({ role: 'assistant', content: aiResponse.reply });
    data.history = history.slice(-20);
    await updateConversation(phone, 'ACTIVE', data);
    return aiResponse.reply;
  }

  // ── ADD MESSAGE TO HISTORY ──
  history.push({ role: 'user', content: message });

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

  // ── HANDLE INTENTS ──
  if (aiResponse.intent === 'check_queue') {
    const patient = await pool.query(
      'SELECT * FROM patients WHERE phone = $1 AND status = $2', [phone, 'waiting']
    );
    if (patient.rows.length > 0) {
      const p = patient.rows[0];
      const reply = `Your current queue status:\n\n🔢 Queue Number: *#${p.queue_number}*\n🏥 Department: *${p.department}*\n⏳ Status: *Waiting*\n\nPlease remain seated. I'll notify you when it's your turn! 😊`;
      history.push({ role: 'assistant', content: reply });
      data.history = history.slice(-20);
      await updateConversation(phone, 'ACTIVE', data);
      return reply;
    }
    const reply = `You don't have an active queue number yet.\n\nWould you like to register as a walk-in patient?`;
    history.push({ role: 'assistant', content: reply });
    data.history = history.slice(-20);
    await updateConversation(phone, 'ACTIVE', data);
    return reply;
  }

  if (aiResponse.intent === 'cancel_appointment') {
    await pool.query(
      `UPDATE appointments SET status = 'cancelled' WHERE phone = $1 AND status IN ('scheduled', 'reminder_sent')`,
      [phone]
    );
    await updateConversation(phone, 'START', {});
    return `Your appointment has been cancelled${data.name ? ', ' + data.name : ''}. 😊\n\nWe hope to see you another time. If you need to rebook just message us again.\n\n_— Zero_`;
  }

  if (aiResponse.intent === 'doctor_done') {
    const current = await pool.query(
      `SELECT * FROM patients WHERE status = 'waiting' ORDER BY queue_number ASC LIMIT 1`
    );
    if (current.rows.length > 0) {
      await pool.query(
        `UPDATE patients SET status = 'seen' WHERE id = $1`, [current.rows[0].id]
      );
      const next = await pool.query(
        `SELECT * FROM patients WHERE status = 'waiting' ORDER BY queue_number ASC LIMIT 1`
      );
      if (next.rows.length > 0) {
        const n = next.rows[0];
        await sendWhatsApp(n.phone,
          `🔔 *Hi ${n.name}!* It's your turn!\n\nPlease proceed to the consultation room. The doctor is ready for you. 🏥\n\n_— Zero_`
        );
        await notifyClinic('next', {
          queueNumber: n.queue_number,
          name: n.name,
          department: n.department,
          complaint: n.complaint
        }, config);
        return `✅ Patient #${current.rows[0].queue_number} marked as seen.\n\n*Next patient called:*\n👤 ${n.name} — #${n.queue_number}\n🏥 ${n.department}`;
      }
      return `✅ Patient marked as seen.\n\nNo more patients in the queue. 🎉`;
    }
    return `No active patients in the queue.`;
  }

  // ── HANDLE COMPLETE INTAKE ──
  if (aiResponse.is_complete) {
    const routing = await getAIRouting(data.complaint, data.symptoms || '');

    if (data.mode === 'appointment') {
      await saveAppointment(data, routing);
      await notifyClinic('appointment', {
        name: data.name, age: data.age, gender: data.gender,
        phone: phone, complaint: data.complaint,
        department: routing.department,
        appointment_date: data.appointment_date,
        appointment_time: data.appointment_time
      }, config);
      await updateConversation(phone, 'DONE', { phone, history: [] });
      return `✅ *Appointment Confirmed, ${data.name}!*\n\n` +
        `📅 Date: *${data.appointment_date}*\n` +
        `🕐 Time: *${data.appointment_time}*\n` +
        `🏥 Department: *${routing.department}*\n\n` +
        `The clinic has been notified. Please arrive 10 minutes early.\n\n` +
        `_See you soon! — Zero_ 🤖`;
    }

    if (data.mode === 'onmyway') {
      await notifyClinic('onmyway', {
        name: data.name, age: data.age, gender: data.gender,
        phone: phone, complaint: data.complaint,
        symptoms: data.symptoms || '',
        department: routing.department,
        urgency: routing.urgency,
        summary: routing.summary
      }, config);
      await updateConversation(phone, 'DONE', { phone, history: [] });
      return `✅ *Got it, ${data.name}!*\n\nThe clinic has been notified you're on your way! 🚗\n\n🏥 Likely Department: *${routing.department}*\n\nA queue number will be assigned when you arrive.\n\n_See you soon! — Zero_ 🤖`;
    }

    // ── WALK-IN ──
    const queueNumber = await getNextQueueNumber();
    await savePatient(data, queueNumber, routing);
    await notifyClinic('walkin', {
      queueNumber,
      name: data.name, age: data.age, gender: data.gender,
      phone: phone, complaint: data.complaint,
      symptoms: data.symptoms || '',
      department: routing.department,
      urgency: routing.urgency,
      summary: routing.summary
    }, config);
    await updateConversation(phone, 'DONE', { phone, history: [] });

    return `✅ *You're all set, ${data.name}!*\n\n` +
      `🔢 Queue Number: *#${queueNumber}*\n` +
      `🏥 Department: *${routing.department}*\n` +
      `${routing.urgency === 'High' ? '🔴' : routing.urgency === 'Medium' ? '🟡' : '🟢'} Urgency: *${routing.urgency}*\n\n` +
      `Please take a seat at reception. I'll message you when it's your turn.\n\n` +
      `_Thank you for your patience! — Zero_ 🤖`;
  }

  // ── CONTINUE CONVERSATION ──
  history.push({ role: 'assistant', content: aiResponse.reply });
  data.history = history.slice(-20);
  await updateConversation(phone, 'ACTIVE', data);
  return aiResponse.reply;
}

// ─── TWILIO WEBHOOK ───────────────────────────────────
app.post('/webhook/whatsapp', async (req, res) => {
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
      <Response><Message>Sorry, something went wrong. Please try again or speak to reception.</Message></Response>`);
  }
});

// ─── API ENDPOINTS ────────────────────────────────────
app.get('/api/patients/active', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM patients 
       WHERE DATE(created_at) = CURRENT_DATE 
       AND status = 'waiting'
       ORDER BY queue_number ASC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats/today', async (req, res) => {
  try {
    const total = await pool.query(
      `SELECT COUNT(*) FROM patients WHERE DATE(created_at) = CURRENT_DATE`
    );
    const waiting = await pool.query(
      `SELECT COUNT(*) FROM patients WHERE DATE(created_at) = CURRENT_DATE AND status = 'waiting'`
    );
    const seen = await pool.query(
      `SELECT COUNT(*) FROM patients WHERE DATE(created_at) = CURRENT_DATE AND status = 'seen'`
    );
    const appointments = await pool.query(
      `SELECT COUNT(*) FROM appointments WHERE DATE(created_at) = CURRENT_DATE`
    );
    const avgWait = await pool.query(
      `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/60)) as avg_minutes
       FROM patients 
       WHERE DATE(created_at) = CURRENT_DATE AND status = 'seen'`
    );
    res.json({
      total: parseInt(total.rows[0].count),
      waiting: parseInt(waiting.rows[0].count),
      seen: parseInt(seen.rows[0].count),
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
  const validStatuses = ['waiting', 'seen', 'done', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const result = await pool.query(
      `UPDATE patients SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }
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
      return res.json({ message: 'No patients in queue', next: null });
    }
    await pool.query(
      `UPDATE patients SET status = 'seen', updated_at = NOW() WHERE id = $1`,
      [current.rows[0].id]
    );
    const next = await pool.query(
      `SELECT * FROM patients WHERE status = 'waiting' ORDER BY queue_number ASC LIMIT 1`
    );
    if (next.rows.length > 0) {
      const n = next.rows[0];
      await sendWhatsApp(n.phone,
        `🔔 *Hi ${n.name}!* It's your turn!\n\nPlease proceed to the consultation room. The doctor is ready for you. 🏥\n\n_— Zero_`
      );
      await notifyClinic('next', {
        queueNumber: n.queue_number,
        name: n.name,
        department: n.department,
        complaint: n.complaint
      }, config);
      return res.json({
        message: 'Queue advanced',
        previous: current.rows[0],
        next: next.rows[0]
      });
    }
    res.json({
      message: 'No more patients in queue',
      previous: current.rows[0],
      next: null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/appointments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM appointments ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'LatencyZero Clinic API running 🏥' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Clinic API running on port ${PORT}`);
});