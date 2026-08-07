/*
  Year 5 writing site — server for Render

  This is a complete, ready-to-deploy Express server. It gives you:
    1. /api/writing-feedback   — real AI feedback on student writing (via Claude)
    2. /api/writing-submit     — every iPad saves student work to YOUR database
    3. /api/writing-class      — your teacher view loads the whole class from anywhere

  You should not need to edit this file. Everything that needs to be set
  per-deployment (API key, database, password) is read from environment
  variables, which you set in the Render dashboard — never write secrets
  into this file directly.

  ============================================================
  SETUP — see the README.md in this same folder for the full walkthrough
  ============================================================
*/

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create the table on boot if it isn't there yet.
pool.query(`
  CREATE TABLE IF NOT EXISTS writing_work (
    username     TEXT PRIMARY KEY,
    activity     TEXT NOT NULL DEFAULT 'cockatoo-report',
    payload      JSONB NOT NULL,
    finished     BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`).catch(err => console.error('table setup failed:', err.message));

// Let the writing page call this from wherever it is hosted (e.g. a Claude
// Design / artifact link, which is a different domain to your Render app).
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// A plain landing page, so visiting the Render URL in a browser shows
// something other than "Cannot GET /" — useful for checking it's alive.
app.get('/', (req, res) => {
  res.send('Writing feedback server is running.');
});


/* ----------------------------------------------------------
   1. AI FEEDBACK
   ---------------------------------------------------------- */

const SYSTEM = `You are a Year 5 teacher in Western Australia giving written feedback on a student's writing.

The class is learning to write INFORMATION REPORTS about the Australian black cockatoo. The focus is:
- using facts, not opinions
- objective language (no "I think", no "best", no "should")
- a topic sentence that names the subject
- precise, technical vocabulary (habitat, eucalypt, hollow, marri, jarrah, banksia, endangered, species, wingspan)
- capital letters, full stops and commas
- correct spelling

TONE: gentle and encouraging. These are 10 and 11 year olds. Open with genuine, specific praise for something they actually did. Then name AT MOST TWO things to fix — the two that matter most. Never list everything wrong. Never be sarcastic. Speak directly to the student as "you".

RULES:
- If they used opinion language, that is always the most important point. Explain WHY an information report does not use opinions, and suggest a factual replacement.
- Quote the student's own words when pointing something out.
- Keep each point to one or two short sentences a Year 5 can read.
- Never rewrite the whole thing for them. Guide, do not replace.
- If the writing is genuinely good, say so and give one way to stretch it.

Reply with ONLY a JSON object, no other text:
{
  "praise": "one sentence of specific praise",
  "points": [
    { "category": "Opinion" | "Facts" | "Spelling" | "Punctuation" | "Structure" | "Vocabulary" | "Length", "text": "what to fix and why" }
  ],
  "nextStep": "one sentence telling them what to do now"
}`;

app.post('/api/writing-feedback', async (req, res) => {
  try {
    const { text, stage, notes, targetSentences, isRevision, topic } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.json({ praise: 'Write something first, then I can help.', points: [], nextStep: '' });
    }

    const task = stage === 'paragraph'
      ? `The student was asked to write ${targetSentences || 3} sentences about where black cockatoos live and what they eat, starting with a topic sentence.`
      : `The student was asked to turn these notes into ONE full sentence for an information report: ${(notes || []).join('; ')}.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 700,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `Topic: ${topic || 'Australian black cockatoo'}
${task}
${isRevision ? 'This is their SECOND attempt, after feedback. Notice what they improved and say so.' : 'This is their first attempt.'}

Student's writing:
"""
${String(text).slice(0, 2000)}
"""`
      }]
    });

    const raw = (message.content[0] && message.content[0].text) || '';
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : null;

    if (!parsed || !parsed.praise || !Array.isArray(parsed.points)) {
      return res.status(502).json({ error: 'unexpected response' });
    }

    parsed.points = parsed.points.slice(0, 2);
    res.json(parsed);
  } catch (err) {
    console.error('writing-feedback failed:', err.message);
    res.status(500).json({ error: 'feedback unavailable' });
  }
});


/* ----------------------------------------------------------
   2. SAVING STUDENT WORK
   ---------------------------------------------------------- */

// Each iPad posts here as the student writes. Latest submission wins,
// so a student can stop and come back without losing anything.
app.post('/api/writing-submit', async (req, res) => {
  try {
    const { username, payload, finished, activity } = req.body || {};
    const name = String(username || '').trim();
    if (!/^[A-Za-z][A-Za-z'-]*\.[A-Za-z]$/.test(name)) {
      return res.status(400).json({ error: 'bad username' });
    }
    await pool.query(
      `INSERT INTO writing_work (username, activity, payload, finished, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (username) DO UPDATE
         SET payload = $3, finished = $4, activity = $2, updated_at = NOW()`,
      [name, activity || 'cockatoo-report', payload || {}, !!finished]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('writing-submit failed:', err.message);
    res.status(500).json({ error: 'save failed' });
  }
});

// Your teacher view calls this to pull the whole class.
app.get('/api/writing-class', async (req, res) => {
  try {
    if (String(req.query.password || '') !== String(process.env.TEACHER_PASSWORD || '')) {
      return res.status(401).json({ error: 'wrong password' });
    }
    const { rows } = await pool.query(
      `SELECT username, payload, finished, updated_at
         FROM writing_work
        WHERE activity = $1
        ORDER BY updated_at DESC`,
      [req.query.activity || 'cockatoo-report']
    );
    res.json({
      students: rows.map(r => Object.assign({}, r.payload, {
        username: r.username,
        finished: r.finished,
        updatedAt: new Date(r.updated_at).getTime()
      }))
    });
  } catch (err) {
    console.error('writing-class failed:', err.message);
    res.status(500).json({ error: 'load failed' });
  }
});


/* ----------------------------------------------------------
   Start the server
   ---------------------------------------------------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Writing feedback server listening on ' + PORT));
