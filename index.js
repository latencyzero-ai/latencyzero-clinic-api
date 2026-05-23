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

// ─── ZERO AI BRAIN ────────────────────────────────────
async function zeroAI(message, history, collectedData, config) {
  const systemPrompt = `You are Zero, a warm and intelligent clinic assistant for ${config.clinic_name}.
You help patients register and book appointments through WhatsApp.

WHAT YOU NEED TO COLLECT:
- name: patient's full name
- age: number only (extract from "I'm 28", "28 years old", "age is 28" etc)
- gender: Male/Female/Prefer not to say (accept m/f/male/female/1/2/3)
- mode: HOW they are visiting:
    "walkin" = at the clinic right now
    "onmyway" = coming to clinic soon  
    "appointment" = booking for future date
- complaint: main reason for visit (extract from "I don't feel well", "I have a headache" etc)
- symptoms: detailed description of how they feel
- appointment_date: only if mode is appointment
- appointment_time: only if mode is appointment

ALREADY COLLECTED FROM THIS PATIENT:
${JSON.stringify(collectedData)}

CRITICAL RULES:
1. Read the FULL conversation history — extract info from ANY previous message
2. NEVER ask for information already collected or mentioned anywhere in history
3. "I don't feel well" = complaint. Ask for MORE detail as symptoms
4. "I'm already here/at the clinic" = mode walkin
5. "I'm coming/on my way" = mode onmyway  
6. "I want to book/appointment/tomorrow/next week" = mode appointment
7. Extract name AND age AND mode from a single message if patient provides them
8. Use patient's name naturally once you know it
9. Ask for maximum 2 pieces of missing info at a time
10. Keep responses SHORT and friendly — this is WhatsApp not email
11. When you have name + age + gender + mode + complaint + symptoms → set is_complete to TRUE
12. For appointments also need appointment_date + appointment_time before is_complete

INTENT DETECTION — ONLY set these for EXACT phrases:
- "doctor_done": ONLY if message is exactly "done", "next", "next patient", "mark done", "mark complete"
- "restart": ONLY if message is "restart", "start over", "reset", "menu"  
- "check_queue": ONLY if message is "queue", "check queue", "my number", "queue status"
- "collecting": everything else — normal conversation

DO NOT set doctor_done for phrases like "that's all", "no", "nothing else", "I'm done" — those are just conversation endings.

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

  // ── RESTART ──
  if (['restart', 'reset', 'start over', 'menu'].includes(msg)) {
    const welcomeMsg =
      `${greeting}! 👋 I'm *Zero*, your clinic assistant.\n\n` +
      `Welcome back to *${config.clinic_name}*!\n\n` +
      `How can I help you today?`;
    await updateConversation(phone, 'ACTIVE', { phone, history: [{ role: 'assistant', content: welcomeMsg }] });
    return welcomeMsg;
  }

  // ── FIRST TIME ──
  if (conv.state === 'START') {
    const welcomeMsg =
      `${greeting}! 👋 I'm *Zero*, your clinic assistant.\n\n` +
      `Welcome to *${config.clinic_name}*!\n\n` +
      `I'm here to help you register, book an appointment, or check your queue status.\n\n` +
      `How can I help you today?`;

    // Process their first message immediately after welcome
    history = [{ role: 'assistant', content: welcomeMsg }];
    data.history = history;
    await updateConversation(phone, 'ACTIVE', data);

    // If first message is just a greeting return welcome only
    const greetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'hii', 'helo'];
    if (greetings.some(g => msg.includes(g)) && msg.length < 20) {
      return welcomeMsg;
    }

    // Otherwise process their first message immediately
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

// ─── PATCH PATIENT STATUS ─────────────────────────────
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

// ─── POST QUEUE NEXT ──────────────────────────────────
app.post('/api/queue/next', async (req, res) => {
  try {
    const config = await getConfig();

    // Mark current as seen
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

    // Get next patient
    const next = await pool.query(
      `SELECT * FROM patients WHERE status = 'waiting' ORDER BY queue_number ASC LIMIT 1`
    );

    if (next.rows.length > 0) {
      const n = next.rows[0];

      // Notify patient on WhatsApp
      await sendWhatsApp(n.phone,
        `🔔 *Hi ${n.name}!* It's your turn!\n\nPlease proceed to the consultation room. The doctor is ready for you. 🏥\n\n_— Zero_`
      );

      // Notify clinic
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

// ─── GET TODAY'S STATS ────────────────────────────────
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

// ─── GET ACTIVE PATIENTS ──────────────────────────────
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