import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import { CS_PROMPT, ASISTEN_PROMPT, WEB_PROMPT } from './prompts.js';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));

const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: (o, cb) => (!o || origins.includes(o)) ? cb(null, true) : cb(new Error('CORS')) }));
app.use(rateLimit({ windowMs: 60_000, max: 30 }));

const faq = JSON.parse(fs.readFileSync('./faq.json', 'utf8'));

const PERSONA = {
  asisten:    { temp: 0.4, max: 1200, sys: ASISTEN_PROMPT },
  'ai-web':   { temp: 0.7, max: 500,  sys: WEB_PROMPT },
  'cs-admin': { temp: 0.6, max: 350,  sys: CS_PROMPT }
};

// Cache di memori (hilang saat restart). Untuk cache awet, ganti ke Upstash Redis.
const cache = new Map();
const TTL = 6 * 3600_000;
const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
const fromFaq = q => faq.find(f => f.k.some(k => q.includes(k)))?.a;

const sse = (res, text) => res.write(`data: ${JSON.stringify(text)}\n\n`);
const done = res => { res.write('data: [DONE]\n\n'); res.end(); };

async function askGroq(res, messages, { temp, max }) {
  let r;
  try {
    r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages, stream: true, temperature: temp, max_tokens: max
      })
    });
  } catch (e) { console.error('Groq fetch', e.message); r = null; }

  if (!r || !r.ok) {
    if (r) console.error('Groq error', r.status, await r.text());
    done(res);               // tanpa teks -> widget otomatis pakai cadangan
    return '';
  }
  let full = '', buf = '';
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      if (!l.startsWith('data: ')) continue;
      const d = l.slice(6).trim();
      if (d === '[DONE]') continue;
      try {
        const t = JSON.parse(d).choices[0].delta.content;
        if (t) { full += t; sse(res, t); }
      } catch {}
    }
  }
  done(res);
  return full;
}

const handler = name => async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length || messages.length > 40)
    return res.status(400).json({ error: 'messages tidak valid' });

  const hist = messages.slice(-8)
    .filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  const last = hist[hist.length - 1];
  if (!last || last.role !== 'user') return res.status(400).json({ error: 'pesan terakhir harus user' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const p = PERSONA[name];
  const q = norm(last.content);
  const cacheable = name !== 'asisten' && hist.length === 1;

  if (cacheable) {
    const f = name === 'cs-admin' ? fromFaq(q) : null;
    if (f) { sse(res, f); return done(res); }
    const hit = cache.get(`${name}:${q}`);
    if (hit && Date.now() - hit.t < TTL) { sse(res, hit.a); return done(res); }
  }

  const full = await askGroq(res, [{ role: 'system', content: p.sys }, ...hist], p);
  if (cacheable && full) {
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    cache.set(`${name}:${q}`, { a: full, t: Date.now() });
  }
};

const adminOnly = (req, res, next) =>
  req.get('x-admin-token') === process.env.ADMIN_TOKEN ? next() : res.status(401).json({ error: 'unauthorized' });

app.post('/api/asisten', adminOnly, handler('asisten'));
app.post('/api/ai-web', handler('ai-web'));
app.post('/api/cs-admin', handler('cs-admin'));
app.get('/health', (_, res) => res.send('ok'));

app.listen(process.env.PORT || 3000, () => console.log('Server jalan'));
