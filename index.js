require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── CONVERSATION STATES ───────────────────────────────
const STATES = {
  START: 'START',
  NAME: 'NAME',
  AGE: 'AGE',
  GENDER: 'GENDER',
  COMPLAINT: 'COMPLAINT',
  SYMPTOMS: 'SYMPTOMS',
  COMPLETE: 'COMPLETE'
};

// ─── GET CONVERSATION STATE ────────────────────────────
async function getConversation(phone) {
  const result = await pool.query(
    'SELECT * FROM conversations WHERE phone = $1',
    [phone]
  );
  if (result.rows.length === 0) {
    await pool.query(
      'INSERT INTO conversations (phone, state, data) VALUES ($1, $2, $3)',
      [phone, STATES.START, '{}']
    );
    return { phone, state: STATES.START, data: {} };
  }
  return result.rows[0];
}

// ─── UPDATE CONVERSATION STATE ─────────────────────────
async function updateConversation(phone, state, data) {
  await pool.query(
    `INSERT INTO conversations (phone, state, data, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (phone) DO UPDATE 
     SET state = $2, data = $3, updated_at = NOW()`,
    [phone, state, JSON.stringify(data)]
  );
}

// ─── GET NEXT QUEUE NUMBER ─────────────────────────────
async function getNextQueueNumber() {
  const today = new Date().toISOString().split('T')[0];
  
  const existing = await pool.query(
    'SELECT * FROM queue WHERE date = $1',
    [today]
  );

  if (existing.rows.length === 0) {
    await pool.query(
      'INSERT INTO queue (date, last_number) VALUES ($1, 1)',
      [today]
    );
    return 1;
  }

  const next = existing.rows[0].last_number + 1;
  await pool.query(
    'UPDATE queue SET last_number = $1 WHERE date = $2',
    [next, today]
  );
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
          content: `A patient at a clinic has the following complaint: "${complaint}" and symptoms: "${symptoms}". 
          Based on this, respond ONLY with a JSON object like this:
          {"department": "General/Dental/Cardiology/Neurology", "urgency": "Low/Medium/High", "summary": "one sentence summary"}
          No other text, just the JSON.`
        }],
        max_tokens: 150,
        temperature: 0.3
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const content = response.data.choices[0].message.content;
    return JSON.parse(content);
  } catch (e) {
    return { department: 'General', urgency: 'Low', summary: complaint };
  }
}

// ─── SAVE PATIENT ─────────────────────────────────────
async function savePatient(data, queueNumber, routing) {
  const result = await pool.query(
    `INSERT INTO patients 
     (phone, name, age, gender, complaint, symptoms, department, urgency, queue_number, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'waiting')
     RETURNING *`,
    [
      data.phone, data.name, data.age, data.gender,
      data.complaint, data.symptoms,
      routing.department, routing.urgency, queueNumber
    ]
  );
  return result.rows[0];
}

// ─── PROCESS MESSAGE ──────────────────────────────────
async function processMessage(phone, message) {
  const conv = await getConversation(phone);
  const state = conv.state;
  const data = conv.data || {};
  data.phone = phone;

  const msg = message.trim();

  // Doctor "done" trigger
  if (msg.toLowerCase() === 'done' || msg.toLowerCase() === 'next') {
    await pool.query(
      `UPDATE patients SET status = 'seen', updated_at = NOW() 
       WHERE phone = $1 AND status = 'waiting'`,
      [phone]
    );
    return '✅ Patient marked as seen. Queue has been updated.';
  }

  switch (state) {
    case STATES.START:
      await updateConversation(phone, STATES.NAME, data);
      return `👋 Welcome to the clinic!\n\nI'll help you register quickly so you can be seen by a doctor.\n\nWhat is your *full name*?`;

    case STATES.NAME:
      data.name = msg;
      await updateConversation(phone, STATES.AGE, data);
      return `Thank you, ${data.name}! 😊\n\nHow old are you?`;

    case STATES.AGE:
      if (isNaN(msg)) {
        return 'Please enter a valid age (numbers only). How old are you?';
      }
      data.age = parseInt(msg);
      await updateConversation(phone, STATES.GENDER, data);
      return `What is your gender?\n\nReply with:\n*1* - Male\n*2* - Female\n*3* - Prefer not to say`;

    case STATES.GENDER:
      const genderMap = { '1': 'Male', '2': 'Female', '3': 'Prefer not to say' };
      data.gender = genderMap[msg] || msg;
      await updateConversation(phone, STATES.COMPLAINT, data);
      return `What is your main complaint today? \n\n(Describe what brought you to the clinic)`;

    case STATES.COMPLAINT:
      data.complaint = msg;
      await updateConversation(phone, STATES.SYMPTOMS, data);
      return `Can you describe your symptoms in more detail?\n\n(e.g. how long, how severe, any other symptoms)`;

    case STATES.SYMPTOMS:
      data.symptoms = msg;
      
      // Get AI routing
      const routing = await getAIRouting(data.complaint, data.symptoms);
      
      // Get queue number
      const queueNumber = await getNextQueueNumber();
      
      // Save patient
      await savePatient(data, queueNumber, routing);
      
      // Mark conversation complete
      await updateConversation(phone, STATES.COMPLETE, data);

      return `✅ *You're registered!*\n\n` +
        `🔢 Queue Number: *#${queueNumber}*\n` +
        `🏥 Department: *${routing.department}*\n` +
        `⚠️ Urgency: *${routing.urgency}*\n\n` +
        `Please take a seat at reception. We'll message you when it's your turn.\n\n` +
        `_Thank you for your patience._`;

    case STATES.COMPLETE:
      return `You are already registered! 😊\n\nYour queue number is active. Please wait at reception.\n\nIf you need help, please speak to the receptionist.`;

    default:
      await updateConversation(phone, STATES.START, {});
      return `👋 Welcome to the clinic! What is your *full name*?`;
  }
}

// ─── TWILIO WEBHOOK ───────────────────────────────────
app.post('/webhook/whatsapp', async (req, res) => {
  const phone = req.body.From?.replace('whatsapp:', '');
  const message = req.body.Body;

  if (!phone || !message) {
    return res.status(400).send('Missing phone or message');
  }

  try {
    const reply = await processMessage(phone, message);

    // Send reply via Twilio
    const twilioResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Message>${reply}</Message>
      </Response>`;

    res.set('Content-Type', 'text/xml');
    res.send(twilioResponse);

  } catch (error) {
    console.error('Error:', error);
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Message>Sorry, we encountered an error. Please try again.</Message>
      </Response>`);
  }
});

// ─── GET ALL PATIENTS TODAY ───────────────────────────
app.get('/api/patients', async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM patients 
     WHERE DATE(created_at) = CURRENT_DATE 
     ORDER BY queue_number ASC`
  );
  res.json(result.rows);
});

// ─── GET QUEUE STATUS ─────────────────────────────────
app.get('/api/queue', async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM patients 
     WHERE DATE(created_at) = CURRENT_DATE 
     AND status = 'waiting'
     ORDER BY queue_number ASC`
  );
  res.json(result.rows);
});

// ─── HEALTH CHECK ─────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'LatencyZero Clinic API running 🏥' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Clinic API running on port ${PORT}`);
});