require('dotenv').config();
const express = require('express');
const pg = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const client = new pg.Client(process.env.DATABASE_URL);
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// Connect to database
client.connect();

// Auto-create tables on startup
async function createTables() {
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR UNIQUE NOT NULL,
        password VARCHAR NOT NULL,
        name VARCHAR,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id),
        name VARCHAR,
        phone VARCHAR,
        email VARCHAR,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        last_contact TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS communications (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id),
        client_id INT REFERENCES clients(id),
        type VARCHAR,
        sender_name VARCHAR,
        phone VARCHAR,
        email VARCHAR,
        subject VARCHAR,
        content TEXT,
        raw_screenshot BYTEA,
        extracted_text TEXT,
        cleared BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id),
        client_id INT REFERENCES clients(id),
        title VARCHAR,
        description TEXT,
        priority INT DEFAULT 3,
        status VARCHAR DEFAULT 'open',
        communication_ids INT[],
        created_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      );
    `);
    console.log("Tables created or already exist");
  } catch (err) {
    console.error("Error creating tables:", err);
  }
}

createTables();

// ============ UTILITY FUNCTIONS ============

function extractContacts(text) {
  const phoneRegex = /(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})/g;
  const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
  const phones = text.match(phoneRegex) || [];
  const emails = text.match(emailRegex) || [];
  return { phones, emails };
}

async function findMatchingClient(userId, phones, emails) {
  if (phones.length === 0 && emails.length === 0) return null;
  const cleanPhones = phones.map(p => p.replace(/\D/g, '').slice(-10));
  for (const phone of cleanPhones) {
    const result = await client.query(
      'SELECT * FROM clients WHERE user_id = $1 AND phone LIKE $2',
      [userId, `%${phone}`]
    );
    if (result.rows.length > 0) return result.rows[0];
  }
  for (const email of emails) {
    const result = await client.query(
      'SELECT * FROM clients WHERE user_id = $1 AND email = $2',
      [userId, email.toLowerCase()]
    );
    if (result.rows.length > 0) return result.rows[0];
  }
  return null;
}

// ============ AUTHENTICATION ============

app.post('/auth/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await client.query(
      'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email, hashedPassword, name]
    );
    const token = jwt.sign({ userId: result.rows[0].id }, process.env.JWT_SECRET);
    res.json({ token, user: result.rows[0] });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await client.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ============ SCREENSHOT CAPTURE ENDPOINT ============

app.post('/api/capture', verifyToken, async (req, res) => {
  try {
    console.log('>>> CAPTURE REQUEST RECEIVED. Mode:', req.body.mode);
    const { screenshotBase64, mode } = req.body; // 'auto', 'review', 'match', 'text'

    const isTextMode = (mode === 'text');
    const promptText = isTextMode
      ? `Read ALL text visible in this image, exactly as it appears, preserving line breaks. Return ONLY valid JSON with these exact keys: {"senderName": "", "phone": "", "email": "", "subject": "", "content": ""}. Put the entire text you read into "content". If a phone number or email is present in the text, also fill "phone" and "email". Leave "senderName" and "subject" as empty strings.`
      : `Extract from this screenshot: sender name, phone number, email, subject/topic, message content. Return ONLY valid JSON with these exact keys: {"senderName": "", "phone": "", "email": "", "subject": "", "content": ""}. If a field is not found, use empty string.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 }
            },
            { type: 'text', text: promptText }
          ]
        }
      ]
    });

    let extractedData;
    try {
      let responseText = message.content[0].text || '';
      console.log('Claude raw reply:', responseText);
      const firstBrace = responseText.indexOf('{');
      const lastBrace = responseText.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        responseText = responseText.slice(firstBrace, lastBrace + 1);
      }
      extractedData = JSON.parse(responseText);
    } catch (parseErr) {
      console.error('Could not parse Claude response. Raw text was:', message.content?.[0]?.text);
      extractedData = { senderName: '', phone: '', email: '', subject: '', content: '' };
    }

    const contacts = extractContacts(
      `${extractedData.phone} ${extractedData.email} ${extractedData.senderName} ${extractedData.content}`
    );

    const matchingClient = await findMatchingClient(req.userId, contacts.phones, contacts.emails);

    const commResult = await client.query(
      `INSERT INTO communications 
       (user_id, client_id, type, sender_name, phone, email, subject, content, raw_screenshot, extracted_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        req.userId,
        matchingClient?.id || null,
        isTextMode ? 'text' : 'screenshot',
        extractedData.senderName,
        extractedData.phone,
        extractedData.email,
        extractedData.subject,
        extractedData.content,
        screenshotBase64,
        JSON.stringify(extractedData)
      ]
    );

    if (mode === 'text' || (mode === 'auto' && matchingClient)) {
      const taskResult = await client.query(
        `INSERT INTO tasks 
         (user_id, client_id, title, description, priority, status, communication_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          req.userId,
          matchingClient?.id || null,
          extractedData.subject || (isTextMode ? 'Captured text' : 'New Task'),
          extractedData.content,
          3,
          'open',
          [commResult.rows[0].id]
        ]
      );
      return res.json({
        mode: mode,
        task: taskResult.rows[0],
        communication: commResult.rows[0],
        client: matchingClient,
        extracted: extractedData
      });
    }

    res.json({
      mode: mode,
      extracted: extractedData,
      matchingClient: matchingClient,
      communication: commResult.rows[0],
      allClients: (await client.query('SELECT id, name, phone, email FROM clients WHERE user_id = $1', [req.userId])).rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============ CLIENT ENDPOINTS ============

app.get('/api/clients', verifyToken, async (req, res) => {
  const result = await client.query(
    'SELECT * FROM clients WHERE user_id = $1 ORDER BY created_at DESC',
    [req.userId]
  );
  res.json(result.rows);
});

app.post('/api/clients', verifyToken, async (req, res) => {
  try {
    const { name, phone, email, notes } = req.body;
    const result = await client.query(
      'INSERT INTO clients (user_id, name, phone, email, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.userId, name, phone, email, notes]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============ TASK ENDPOINTS ============

app.get('/api/tasks', verifyToken, async (req, res) => {
  const result = await client.query(
    `SELECT tasks.*, clients.name as client_name 
     FROM tasks 
     LEFT JOIN clients ON tasks.client_id = clients.id 
     WHERE tasks.user_id = $1 
     ORDER BY tasks.created_at DESC`,
    [req.userId]
  );
  res.json(result.rows);
});

app.post('/api/tasks', verifyToken, async (req, res) => {
  try {
    const { client_id, title, description, priority, communication_ids } = req.body;
    const result = await client.query(
      `INSERT INTO tasks (user_id, client_id, title, description, priority, status, communication_ids)
       VALUES ($1, $2, $3, $4, $5, 'open', $6)
       RETURNING *`,
      [req.userId, client_id, title, description, priority, communication_ids]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/tasks/:id', verifyToken, async (req, res) => {
  try {
    const { status, priority } = req.body;
    const result = await client.query(
      'UPDATE tasks SET status = COALESCE($1, status), priority = COALESCE($2, priority) WHERE id = $3 AND user_id = $4 RETURNING *',
      [status, priority, req.params.id, req.userId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============ COMMUNICATIONS / CAPTURES ENDPOINTS ============

app.get('/api/clients/:id/communications', verifyToken, async (req, res) => {
  const result = await client.query(
    'SELECT * FROM communications WHERE client_id = $1 AND user_id = $2 ORDER BY created_at DESC',
    [req.params.id, req.userId]
  );
  res.json(result.rows);
});

// All captures for the dashboard, with any linked client name
app.get('/api/captures', verifyToken, async (req, res) => {
  try {
    const result = await client.query(
      `SELECT communications.*, clients.name AS client_name
       FROM communications
       LEFT JOIN clients ON communications.client_id = clients.id
       WHERE communications.user_id = $1
       ORDER BY communications.created_at DESC`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Mark a capture as cleared (done)
app.patch('/api/captures/:id/clear', verifyToken, async (req, res) => {
  try {
    const result = await client.query(
      'UPDATE communications SET cleared = true WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.userId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============ SERVE THE DASHBOARD ============

app.use(express.static(path.join(__dirname, 'public')));

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ============ START SERVER ============

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});