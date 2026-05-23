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

// ─── STATES ───────────────────────────────────────────
const STATES = {
  START: 'START',
  MENU: 'MENU',
  // Walk-in & On my way
  NAME: 'NAME',
  AGE: 'AGE',
  GENDER: 'GENDER',
  COMPLAINT: 'COMPLAINT',
  SYMPTOMS: 'SYMPTOMS',
  COMPLETE: 'COMPLETE',
  // Appointment
  APPT_NAME: 'APPT_NAME',
  APPT_AGE: 'APPT_AGE',
  APPT_GENDER: 'APPT_GENDER',
  APPT_COMPLAINT: 'APPT_COMPLAINT',
  APPT_DATE: 'APPT_DATE',
  APPT_TIME: 'APPT_TIME',
  APPT_COMPLETE: 'APPT_COMPLETE'
};

// ─── TIME GREETING ─────────────────────────────────────
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// ─── EXTRACT AGE ──────────────────────────────────────
function extractAge(text) {
  const match = text.match(/\d+/);
  return match ? parseInt(match[0]) : null;
}

// ─── EXTRACT GENDER ───────────────────────────────────
function extractGender(text) {
  const t = text.toLowerCase().trim();
  if (t === '1' || t === 'male' || t === 'm' || t === 'man' || t === 'boy') return 'Male';
  if (t === '2' || t === 'female' || t === 'f' || t === 'woman' || t === 'girl') return 'Female';
  if (t === '3' || t.includes('prefer') || t.includes('not say') || t === 'other') return 'Prefer not to say';
  return null;
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
      [phone, STATES.START, '{}']
    );
    return { phone, state: STATES.START, data: {} };
  }
  const row = result.rows[0];
  return { ...row, data: row.data || {} };
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
    await pool.query('INSERT INTO queue (date, last_number) VALUES ($1, 1)', [today]);
    return 1;
  }
  const next = existing.rows[0].last_number + 1;
  await pool.query('UPDATE queue SET last_number = $1 WHERE date = $2', [next, today]);
  return next;
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
          content: `A patient at a clinic has complaint: "${complaint}" and symptoms: "${symptoms}". 
          Respond ONLY with JSON:
          {"department": "General/Dental/Cardiology/Neurology", "urgency": "Low/Medium/High", "summary": "one sentence"}`
        }],
        max_tokens: 150,
        temperature: 0.3
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
    [data.phone, data.name, data.age, data.gender, data.complaint,
     data.symptoms, routing.department, routing.urgency, queueNumber]
  );
  return result.rows[0];
}

// ─── SAVE APPOINTMENT ─────────────────────────────────
async function saveAppointment(data) {
  const result = await pool.query(
    `INSERT INTO appointments 
     (phone, name, age, gender, complaint, department, appointment_date, appointment_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [data.phone, data.name, data.age, data.gender, data.complaint,
     data.department, data.appointment_date, data.appointment_time]
  );
  return result.rows[0];
}

// ─── NOTIFY VIA WHATSAPP ──────────────────────────────
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
async function notifyClinic(type, data) {
  const config = await getConfig();
  const clinicNumber = config.receptionist_whatsapp;
  const doctorNumber = config.doctor_whatsapp;

  const urgencyEmoji = { 'High': '🔴', 'Medium': '🟡', 'Low': '🟢' };

  let message = '';

  if (type === 'walkin') {
    message =
      `🔔 *New Walk-in Patient*\n\n` +
      `🔢 Queue: *#${data.queueNumber}*\n` +
      `👤 Name: *${data.name}*\n` +
      `🎂 Age: ${data.age} | ${data.gender}\n` +
      `📱 Phone: ${data.phone}\n` +
      `🏥 Department: *${data.department}*\n` +
      `${urgencyEmoji[data.urgency] || '🟢'} Urgency: *${data.urgency}*\n\n` +
      `💬 *Complaint:* ${data.complaint}\n` +
      `🩺 *Symptoms:* ${data.symptoms}\n` +
      `📋 *Summary:* ${data.summary}`;
  }

  if (type === 'onmyway') {
    message =
      `🚗 *Patient On The Way*\n\n` +
      `👤 Name: *${data.name}*\n` +
      `🎂 Age: ${data.age} | ${data.gender}\n` +
      `📱 Phone: ${data.phone}\n` +
      `🏥 Department: *${data.department}*\n` +
      `${urgencyEmoji[data.urgency] || '🟢'} Urgency: *${data.urgency}*\n\n` +
      `💬 *Complaint:* ${data.complaint}\n` +
      `📋 *Summary:* ${data.summary}\n\n` +
      `_Patient will arrive soon. Queue number will be assigned on arrival._`;
  }

  if (type === 'appointment') {
    message =
      `📅 *New Appointment Scheduled*\n\n` +
      `👤 Name: *${data.name}*\n` +
      `🎂 Age: ${data.age} | ${data.gender}\n` +
      `📱 Phone: ${data.phone}\n` +
      `🏥 Department: *${data.department}*\n` +
      `📆 Date: *${data.appointment_date}*\n` +
      `🕐 Time: *${data.appointment_time}*\n\n` +
      `💬 *Complaint:* ${data.complaint}`;
  }

  if (type === 'next') {
    message =
      `✅ *Next Patient Ready*\n\n` +
      `🔢 Queue: *#${data.queueNumber}*\n` +
      `👤 Name: *${data.name}*\n` +
      `🏥 Department: *${data.department}*\n` +
      `💬 *Complaint:* ${data.complaint}\n\n` +
      `_Please call the patient in._`;
  }

  if (clinicNumber) await sendWhatsApp(clinicNumber, message);
  if (doctorNumber && type !== 'onmyway') await sendWhatsApp(doctorNumber, message);
}

// ─── MAIN MENU ────────────────────────────────────────
function getMainMenu(agentName, clinicName, greeting, name) {
  const nameStr = name ? `, ${name}` : '';
  return `${greeting}! 👋 I'm *${agentName}*, your clinic assistant.\n\nWelcome to *${clinicName}*${nameStr}!\n\nHow can I help you today?\n\n1️⃣ I'm at the clinic (Walk-in)\n2️⃣ I'm on my way\n3️⃣ Book an appointment\n4️⃣ Check my queue status`;
}

// ─── PROCESS MESSAGE ──────────────────────────────────
async function processMessage(phone, message) {
  const conv = await getConversation(phone);
  const state = conv.state;
  const data = conv.data || {};
  data.phone = phone;
  const msg = message.trim();
  const config = await getConfig();
  const greeting = getGreeting();

  // ── RESTART KEYWORDS ──
  if (['restart', 'reset', 'start over', 'menu', 'hi', 'hello', 'hey'].includes(msg.toLowerCase())) {
    await updateConversation(phone, STATES.MENU, {});
    return getMainMenu(config.agent_name, config.clinic_name, greeting, null);
  }

  switch (state) {

    // ── START ──
    case STATES.START:
    case STATES.MENU:
      await updateConversation(phone, STATES.MENU, data);
      return getMainMenu(config.agent_name, config.clinic_name, greeting, data.name || null);

    // ── MENU SELECTION ──
    case STATES.MENU:
      if (msg === '1' || msg.toLowerCase().includes('walk') || msg.toLowerCase().includes('clinic')) {
        data.mode = 'walkin';
        await updateConversation(phone, STATES.NAME, data);
        return `Great! Let's get you registered quickly. 😊\n\nWhat is your *full name*?`;
      }
      if (msg === '2' || msg.toLowerCase().includes('way') || msg.toLowerCase().includes('coming')) {
        data.mode = 'onmyway';
        await updateConversation(phone, STATES.NAME, data);
        return `No problem! Let's take your details so the clinic is ready when you arrive. 😊\n\nWhat is your *full name*?`;
      }
      if (msg === '3' || msg.toLowerCase().includes('book') || msg.toLowerCase().includes('appointment')) {
        data.mode = 'appointment';
        await updateConversation(phone, STATES.APPT_NAME, data);
        return `I'll help you book an appointment. 📅\n\nWhat is your *full name*?`;
      }
      if (msg === '4' || msg.toLowerCase().includes('queue') || msg.toLowerCase().includes('status')) {
        const patient = await pool.query(
          'SELECT * FROM patients WHERE phone = $1 AND status = $2', [phone, 'waiting']
        );
        if (patient.rows.length > 0) {
          const p = patient.rows[0];
          return `Your current queue status:\n\n🔢 Queue Number: *#${p.queue_number}*\n🏥 Department: *${p.department}*\n⏳ Status: *Waiting*\n\nPlease remain seated. We'll notify you when it's your turn.`;
        }
        return `You don't have an active queue number.\n\nReply *1* to register as a walk-in patient.`;
      }
      return getMainMenu(config.agent_name, config.clinic_name, greeting, data.name || null);

    // ── WALK-IN & ON MY WAY FLOW ──
    case STATES.NAME:
      data.name = msg;
      await updateConversation(phone, STATES.AGE, data);
      return `Nice to meet you, *${data.name}*! 😊\n\nHow old are you?`;

    case STATES.AGE:
      const age = extractAge(msg);
      if (!age) return `I didn't catch that. Please enter your age as a number.\n\nHow old are you?`;
      data.age = age;
      await updateConversation(phone, STATES.GENDER, data);
      return `What is your gender?\n\nYou can reply with:\n*1* or *Male*\n*2* or *Female*\n*3* or *Prefer not to say*`;

    case STATES.GENDER:
      const gender = extractGender(msg);
      if (!gender) return `I didn't understand that. Please reply with *Male*, *Female*, or *Prefer not to say* (or 1, 2, 3)`;
      data.gender = gender;
      await updateConversation(phone, STATES.COMPLAINT, data);
      return `Thank you, ${data.name}! 🙏\n\nWhat is your main complaint today?\n\n_(What brought you to the clinic?)_`;

    case STATES.COMPLAINT:
      data.complaint = msg;
      await updateConversation(phone, STATES.SYMPTOMS, data);
      return `Can you describe your symptoms in a bit more detail?\n\n_(How long have you had this? How severe is it?)_`;

    case STATES.SYMPTOMS:
      data.symptoms = msg;
      const routing = await getAIRouting(data.complaint, data.symptoms);

      if (data.mode === 'onmyway') {
        await notifyClinic('onmyway', {
          name: data.name, age: data.age, gender: data.gender,
          phone: phone, complaint: data.complaint, symptoms: data.symptoms,
          department: routing.department, urgency: routing.urgency, summary: routing.summary
        });
        await updateConversation(phone, STATES.COMPLETE, { ...data, mode: 'onmyway' });
        return `✅ *Got it, ${data.name}!*\n\nThe clinic has been notified you're on your way.\n\n🏥 Department: *${routing.department}*\n\nA queue number will be assigned when you arrive. See you soon! 🚗`;
      }

      const queueNumber = await getNextQueueNumber();
      await savePatient(data, queueNumber, routing);
      await notifyClinic('walkin', {
        queueNumber, name: data.name, age: data.age, gender: data.gender,
        phone: phone, complaint: data.complaint, symptoms: data.symptoms,
        department: routing.department, urgency: routing.urgency, summary: routing.summary
      });
      await updateConversation(phone, STATES.COMPLETE, { ...data, queueNumber });

      return `✅ *You're registered, ${data.name}!*\n\n` +
        `🔢 Queue Number: *#${queueNumber}*\n` +
        `🏥 Department: *${routing.department}*\n` +
        `⚠️ Urgency: *${routing.urgency}*\n\n` +
        `Please take a seat at reception. I'll message you when it's your turn.\n\n` +
        `_Thank you for your patience. — Zero_ 🤖`;

    case STATES.COMPLETE:
      if (msg.toLowerCase() === 'done' || msg.toLowerCase() === 'next') {
        const current = await pool.query(
          `SELECT * FROM patients WHERE phone = $1 AND status = 'waiting' ORDER BY queue_number ASC LIMIT 1`,
          [phone]
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
              `🔔 *${config.agent_name} here!* It's your turn, *${n.name}*!\n\nPlease proceed to the consultation room. The doctor is ready for you. 🏥`
            );
            await notifyClinic('next', {
              queueNumber: n.queue_number, name: n.name,
              department: n.department, complaint: n.complaint
            });
            return `✅ Patient #${current.rows[0].queue_number} marked as seen.\n\n*Next patient:*\n👤 ${n.name} — #${n.queue_number}\n🏥 ${n.department}`;
          }
          return `✅ Patient marked as seen.\n\nNo more patients in the queue.`;
        }
        return `No active patients found.`;
      }
      return `You are already registered, *${data.name}*! 😊\n\nYour queue number is *#${data.queueNumber}*.\n\nPlease wait at reception. I'll notify you when it's your turn.\n\nReply *menu* to go back to the main menu.`;

    // ── APPOINTMENT FLOW ──
    case STATES.APPT_NAME:
      data.name = msg;
      await updateConversation(phone, STATES.APPT_AGE, data);
      return `Nice to meet you, *${data.name}*! 😊\n\nHow old are you?`;

    case STATES.APPT_AGE:
      const apptAge = extractAge(msg);
      if (!apptAge) return `Please enter your age as a number. How old are you?`;
      data.age = apptAge;
      await updateConversation(phone, STATES.APPT_GENDER, data);
      return `What is your gender?\n\n*1* or *Male*\n*2* or *Female*\n*3* or *Prefer not to say*`;

    case STATES.APPT_GENDER:
      const apptGender = extractGender(msg);
      if (!apptGender) return `Please reply with *Male*, *Female*, or *Prefer not to say* (or 1, 2, 3)`;
      data.gender = apptGender;
      await updateConversation(phone, STATES.APPT_COMPLAINT, data);
      return `What would you like to see the doctor about, *${data.name}*?`;

    case STATES.APPT_COMPLAINT:
      data.complaint = msg;
      const apptRouting = await getAIRouting(data.complaint, '');
      data.department = apptRouting.department;
      await updateConversation(phone, STATES.APPT_DATE, data);
      return `Thank you! Based on your complaint you'll be seeing our *${apptRouting.department}* team.\n\nWhat date would you like to come in?\n\n_(e.g. "Monday", "25th May", "tomorrow")_`;

    case STATES.APPT_DATE:
      data.appointment_date = msg;
      await updateConversation(phone, STATES.APPT_TIME, data);
      return `What time works best for you?\n\n_(e.g. "9am", "2:30pm", "morning")_`;

    case STATES.APPT_TIME:
      data.appointment_time = msg;
      await saveAppointment(data);
      await notifyClinic('appointment', {
        name: data.name, age: data.age, gender: data.gender,
        phone: phone, complaint: data.complaint, department: data.department,
        appointment_date: data.appointment_date, appointment_time: data.appointment_time
      });
      await updateConversation(phone, STATES.APPT_COMPLETE, data);
      return `✅ *Appointment Confirmed, ${data.name}!*\n\n` +
        `📅 Date: *${data.appointment_date}*\n` +
        `🕐 Time: *${data.appointment_time}*\n` +
        `🏥 Department: *${data.department}*\n\n` +
        `The clinic has been notified of your appointment. Please arrive 10 minutes early.\n\n` +
        `_See you soon! — Zero_ 🤖`;

    default:
      await updateConversation(phone, STATES.MENU, {});
      return getMainMenu(config.agent_name, config.clinic_name, greeting, null);
  }
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
    console.error('Error:', error);
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