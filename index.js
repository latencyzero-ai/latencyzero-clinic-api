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
  return result.rows[0] || { clinic_name: 'Our Clinic', agent_name: 'Zero' };
}

// ─── GET CONVERSATION HISTORY ─────────────────────────
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
  return {
    ...row,
    data: row.data || {},
    history: row.data?.history || []
  };
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

// ─── ZERO AI BRAIN ────────────────────────────────────
async function zeroAI(message, history, collectedData, config) {
  const systemPrompt = `You are Zero, a friendly and intelligent clinic assistant for ${config.clinic_name}. 
Your job is to register patients and help them with clinic services through WhatsApp.

You need to collect this information from patients:
- name (full name)
- age (number only)
- gender (Male/Female/Prefer not to say)
- mode (walkin=at clinic, onmyway=coming to clinic, appointment=booking future visit)
- complaint (main reason for visit)
- symptoms (detailed description)
- If appointment: appointment_date and appointment_time

Already collected from this patient: ${JSON.stringify(collectedData)}

IMPORTANT RULES ABOUT HISTORY:
- Read the FULL conversation history above carefully before responding
- Extract ANY information the patient mentioned at ANY point in the conversation
- "I don't feel well", "I have a headache", "my stomach hurts" ALL count as complaint
- If patient says "already told you" — search the history and find what they said
- Never ask for something already mentioned anywhere in the conversation
- Connect information across messages e.g. "I don't feel well" + "I'd like to come in tomorrow" = complaint + appointment mode

Rules:
1. Be warm, friendly and conversational like a real person
2. Extract ANY information the patient mentions even if not directly asked
3. Never ask for information already collected
4. Ask for one or two pieces of missing info at a time naturally
5. Use the patient's name once you know it
6. If patient says something unclear ask for clarification kindly
7. When ALL required info is collected set is_complete to true
8. For appointments you also need appointment_date and appointment_time
9. If patient says "done", "next", "mark done" set intent to "doctor_done"
10. If patient says "restart", "menu", "start over" set intent to "restart"
11. If patient says "check queue", "my number", "queue status" set intent to "check_queue"
12. Always respond in the same language the patient uses
13. Keep responses concise and clear for WhatsApp

Respond ONLY with this JSON:
{
  "reply": "your friendly response to the patient",
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
  "intent": "collecting/doctor_done/restart/check_queue"
}

Only include fields in extracted that you actually found in the message. 
is_complete should be true only when you have: name, age, gender, mode, complaint, and symptoms (plus date/time if appointment).`;

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
      temperature: 0.4,
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

// ─── PROCESS MESSAGE ──────────────────────────────────
async function processMessage(phone, message) {
  const conv = await getConversation(phone);
  const config = await getConfig();
  const greeting = getGreeting();

  let data = conv.data || {};
  let history = data.history || [];
  data.phone = phone;

  // First message — send welcome
  if (conv.state === 'START') {
    const welcomeMsg =
      `${greeting}! 👋 I'm *Zero*, your clinic assistant.\n\n` +
      `Welcome to *${config.clinic_name}*!\n\n` +
      `I'm here to help you register, book an appointment, or check your queue status.\n\n` +
      `How can I help you today?`;

    history.push({ role: 'assistant', content: welcomeMsg });
    data.history = history;
    await updateConversation(phone, 'ACTIVE', data);
    return welcomeMsg;
  }

  // Add patient message to history
  history.push({ role: 'user', content: message });

  // Call Zero AI brain
  const aiResponse = await zeroAI(message, history.slice(-20), data, config);

  // Merge extracted data
  if (aiResponse.extracted) {
    Object.keys(aiResponse.extracted).forEach(key => {
      if (aiResponse.extracted[key] !== null && aiResponse.extracted[key] !== undefined) {
        data[key] = aiResponse.extracted[key];
      }
    });
  }

  // Handle intents
  if (aiResponse.intent === 'restart') {
    await updateConversation(phone, 'START', {});
    return `${greeting}! 👋 I'm *Zero*, your clinic assistant.\n\nWelcome back to *${config.clinic_name}*!\n\nHow can I help you today?`;
  }

  if (aiResponse.intent === 'check_queue') {
    const patient = await pool.query(
      'SELECT * FROM patients WHERE phone = $1 AND status = $2', [phone, 'waiting']
    );
    if (patient.rows.length > 0) {
      const p = patient.rows[0];
      return `Your current queue status:\n\n🔢 Queue Number: *#${p.queue_number}*\n🏥 Department: *${p.department}*\n⏳ Status: *Waiting*\n\nPlease remain seated. I'll notify you when it's your turn! 😊`;
    }
    return `You don't have an active queue number yet.\n\nWould you like to register as a walk-in patient?`;
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

  // Handle completed intake
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
      await updateConversation(phone, 'DONE', { ...data, history: [] });
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
        phone: phone, complaint: data.complaint, symptoms: data.symptoms,
        department: routing.department, urgency: routing.urgency, summary: routing.summary
      }, config);
      await updateConversation(phone, 'DONE', { ...data, history: [] });
      return `✅ *Got it, ${data.name}!*\n\nThe clinic has been notified you're on your way! 🚗\n\n🏥 Likely Department: *${routing.department}*\n\nA queue number will be assigned when you arrive.\n\n_See you soon! — Zero_ 🤖`;
    }

    // Walk-in
    const queueNumber = await getNextQueueNumber();
    await savePatient(data, queueNumber, routing);
    await notifyClinic('walkin', {
      queueNumber, name: data.name, age: data.age, gender: data.gender,
      phone: phone, complaint: data.complaint, symptoms: data.symptoms,
      department: routing.department, urgency: routing.urgency, summary: routing.summary
    }, config);
    await updateConversation(phone, 'DONE', { ...data, queueNumber, history: [] });

    return `✅ *You're all set, ${data.name}!*\n\n` +
      `🔢 Queue Number: *#${queueNumber}*\n` +
      `🏥 Department: *${routing.department}*\n` +
      `${routing.urgency === 'High' ? '🔴' : routing.urgency === 'Medium' ? '🟡' : '🟢'} Urgency: *${routing.urgency}*\n\n` +
      `Please take a seat at reception. I'll message you when it's your turn.\n\n` +
      `_Thank you for your patience! — Zero_ 🤖`;
  }

  // Continue conversation
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
app.get('/api/patients', async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM patients WHERE DATE(created_at) = CURRENT_DATE ORDER BY queue_number ASC`
  );
  res.json(result.rows);
});

app.get('/api/queue', async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM patients WHERE DATE(created_at) = CURRENT_DATE AND status = 'waiting' ORDER BY queue_number ASC`
  );
  res.json(result.rows);
});

app.get('/api/appointments', async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM appointments ORDER BY created_at DESC`
  );
  res.json(result.rows);
});

app.get('/', (req, res) => {
  res.json({ status: 'LatencyZero Clinic API running 🏥' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Clinic API running on port ${PORT}`);
});