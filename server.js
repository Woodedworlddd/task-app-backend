require('dotenv').config();
const express = require('express');
const pg = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
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

// Extract phone numbers and emails from text
function extractContacts(text) {
  const phoneRegex = /(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})/g;
  const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
  
  const phones = text.match(phoneRegex) || [];
  const emails = text.match(emailRegex) || [];