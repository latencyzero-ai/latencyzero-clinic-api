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

CURRENT PATIENT DATA ALREADY COLLECTED:
${JSON.stringify(collectedData)}

YOUR ONLY JOB:
Look at what is already collected above. Figure out what is STILL MISSING. Ask for ONLY the missing information.

WHAT YOU NEED TO COLLECT:
- name: patient full name
- age: number (extract from "I'm 45", "45 years old", "age 45" etc)
- gender: Male/Female/Prefer not to say (accept m/f/1/2/3/male/female)
- complaint: main reason for visit (e.g. "chest pain", "toothache")
- symptoms: more detail about how they feel (duration, severity, other symptoms)
- appointment_date: ONLY if mode is "appointment" — accept ANY format like "tomorrow", "Monday", "26th May", "today"
- appointment_time: ONLY if mode is "appointment" — accept ANY format like "4pm", "9am", "morning", "afternoon"

NOTE: "mode" is already set in the collected data above. You NEVER need to ask about mode.

COLLECTION ORDER:
1. First collect: name, age, gender (can be in one message)
2. Then collect: complaint
3. Then collect: symptoms (more detail)
4. If mode is "appointment": collect appointment_date, then appointment_time
5. Once everything is collected: set is_complete to TRUE

RULES:
1. NEVER ask for anything already in CURRENT PATIENT DATA
2. NEVER ask about how they plan to visit — mode is already known
3. Extract info from ANY part of the message even if phrased unusually
4. appointment_date and appointment_time are plain text — accept anything the patient writes
5. Use patient name naturally once known
6. Keep messages SHORT — this is WhatsApp
7. If patient seems frustrated or confused — be calm, apologize briefly and ask the next question simply
8. When ALL required fields are collected — set is_complete to TRUE immediately

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

Only include extracted fields you ACTUALLY found. Set is_complete TRUE only when all required fields exist.`;

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
  // Store date and time as plain text — no parsing
  const result = await pool.query(
    `INSERT INTO appointments 
     (phone, name, age, gender, complaint, department, appointment_date, appointment_time, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'scheduled') RETURNING *`,
    [
      data.phone,
      data.name,
      data.age,
      data.gender,
      data.complaint,
      routing.department,
      data.appointment_date,
      data.appointment_time
    ]
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

  // ── FIRST TIME / SHOW WELCOME ──
  if (conv.state === 'START') {
    const welcomeMsg = buildWelcome(config, greeting, false);
    history = [{ role: 'assistant', content: welcomeMsg }];
    data.history = history;
    await updateConversation(phone, 'MENU', data);
    return welcomeMsg;
  }

  // ── MENU STATE — waiting for selection ──
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
      return `You don't have an active queue number yet.\n\nWould you like to register? Reply *1* for walk-in or *2* to book an appointment.`;
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

    // No valid selection — show menu again
    return buildWelcome(config, greeting, false);
  }

  // ── ACTIVE — collecting patient info ──
  history.push({ role: 'user', content: message });

  // Check for special intents first
  if (msg === 'done' || msg === 'next' || msg === 'next patient' || msg === 'mark done' || msg === 'mark complete') {
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

  if (msg === 'queue' || msg === 'check queue' || msg === 'my number' || msg === 'queue status') {
    const patient = await pool.query(
      'SELECT * FROM patients WHERE phone = $1 AND status = $2', [phone, 'waiting']
    );
    if (patient.rows.length > 0) {
      const p = patient.rows[0];
      return `Your queue status:\n\n🔢 Queue Number: *#${p.queue_number}*\n🏥 Department: *${p.department}*\n⏳ Status: *Waiting*\n\nPlease remain seated! 😊`;
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
    return `Your appointment has been cancelled${data.name ? ', ' + data.name : ''}. 😊\n\nWe hope to see you another time. Message us anytime to rebook.\n\n_— Zero_`;
  }

  // ── HANDLE COMPLETE INTAKE ──
  if (aiResponse.is_complete) {

    // Safety checks
    if (!data.name || !data.age || !data.gender) {
      const reply = `I still need a few details. Could you share your full name, age and gender?`;
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
      const reply = `Can you describe your symptoms in a bit more detail, ${data.name}?`;
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

    const routing = await getAIRouting(data.complaint, data.symptoms || '');

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
      <Response><Message>Sorry, something went wrong. Please try again or speak to reception. 😊\n\n_— Zero_</Message></Response>`);
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
    const total = await pool.query(`SELECT COUNT(*) FROM patients WHERE DATE(created_at) = CURRENT_DATE`);
    const waiting = await pool.query(`SELECT COUNT(*) FROM patients WHERE DATE(created_at) = CURRENT_DATE AND status = 'waiting'`);
    const seen = await pool.query(`SELECT COUNT(*) FROM patients WHERE DATE(created_at) = CURRENT_DATE AND status = 'seen'`);
    const appointments = await pool.query(`SELECT COUNT(*) FROM appointments WHERE DATE(created_at) = CURRENT_DATE`);
    const avgWait = await pool.query(
      `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/60)) as avg_minutes
       FROM patients WHERE DATE(created_at) = CURRENT_DATE AND status = 'seen'`
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
    const result = await pool.query(`SELECT * FROM appointments ORDER BY created_at DESC`);
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