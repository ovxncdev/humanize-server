// server.js — Direct API approach (no UI automation needed)
// Replicates the exact HTTP request humanizeai.pro makes internally

const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const EMAIL = process.env.HUMANIZE_EMAIL;
const PASSWORD = process.env.HUMANIZE_PASSWORD;

let sessionCookies = null;
let isReady = false;

// ============================================
// CHUNK TEXT INTO ≤198 WORD PIECES
// ============================================

function chunkText(text, maxWords = 190) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks = [];
  let current = [];
  let count = 0;

  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).filter(Boolean);
    if (count + words.length > maxWords && current.length > 0) {
      chunks.push(current.join(' ').trim());
      current = [];
      count = 0;
    }
    current.push(sentence.trim());
    count += words.length;
  }
  if (current.length > 0) chunks.push(current.join(' ').trim());
  return chunks;
}

function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15);
}

// ============================================
// LOGIN — get session cookies
// ============================================

async function login() {
  console.log('[Login] Logging in...');

  const res = await fetch('https://www.humanizeai.pro/api/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://www.humanizeai.pro',
      'Referer': 'https://www.humanizeai.pro/login',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  console.log('[Login] Status:', res.status);

  // Grab cookies from response
  const setCookie = res.headers.getSetCookie?.() || [];
  if (setCookie.length > 0) {
    sessionCookies = setCookie.map(c => c.split(';')[0]).join('; ');
    console.log('[Login] Got cookies:', sessionCookies.substring(0, 50) + '...');
  }

  const data = await res.json().catch(() => ({}));
  console.log('[Login] Response:', JSON.stringify(data).substring(0, 200));

  if (!res.ok && !sessionCookies) {
    throw new Error(`Login failed: ${res.status} ${JSON.stringify(data)}`);
  }

  console.log('[Login] Success ✅');
}

// ============================================
// HUMANIZE A SINGLE CHUNK — direct API call
// ============================================

async function humanizeChunk(text) {
  console.log(`[Humanize] ${text.split(/\s+/).length} words`);

  const body = {
    text,
    alg: 0,
    isLogged: true,
    isSample: false,
    keywords: [],
    sessionId: generateSessionId(),
    style: 'free',
    test_allultra: null,
    test_limitNot: null,
    trialNumber: 0,
    ultra: 0,
  };

  const headers = {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Origin': 'https://www.humanizeai.pro',
    'Referer': 'https://www.humanizeai.pro/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  if (sessionCookies) {
    headers['Cookie'] = sessionCookies;
  }

  const res = await fetch('https://www.humanizeai.pro/api/process', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  console.log('[Humanize] Status:', res.status);
  const data = await res.json();
  console.log('[Humanize] Response:', JSON.stringify(data).substring(0, 300));

  if (data?.result?.[0]?.text) {
    return {
      text: data.result[0].text,
      score: data.result[0].scores?.average ?? null,
    };
  }

  throw new Error('No result in response: ' + JSON.stringify(data).substring(0, 200));
}

// ============================================
// STARTUP
// ============================================

async function startup() {
  try {
    await login();
    isReady = true;
    console.log('[Server] Ready ✅');
  } catch (err) {
    console.error('[Startup] Failed:', err.message);
    // Retry after 5s
    setTimeout(startup, 5000);
  }
}

// Re-login every 30 minutes to keep session fresh
setInterval(async () => {
  try {
    await login();
    console.log('[Session] Refreshed');
  } catch (e) {
    console.warn('[Session] Refresh failed:', e.message);
  }
}, 30 * 60 * 1000);

// ============================================
// ROUTES
// ============================================

app.get('/health', (req, res) => {
  res.json({ status: isReady ? 'ready' : 'starting', hasCookies: !!sessionCookies });
});

app.post('/humanize', async (req, res) => {
  if (!isReady) {
    return res.status(503).json({ error: 'Server still starting, try again shortly' });
  }

  const { text } = req.body;
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text field is required' });
  }

  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  console.log(`[POST /humanize] ${wordCount} words`);

  try {
    const chunks = chunkText(text, 190);
    console.log(`[POST /humanize] ${chunks.length} chunk(s)`);

    const results = [];
    let totalScore = 0;
    let scoredChunks = 0;

    for (let i = 0; i < chunks.length; i++) {
      console.log(`[POST /humanize] Chunk ${i + 1}/${chunks.length}`);
      const result = await humanizeChunk(chunks[i]);
      results.push(result.text);
      if (result.score !== null) { totalScore += result.score; scoredChunks++; }
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 1500));
    }

    res.json({
      success: true,
      humanized: results.join(' '),
      humanScore: scoredChunks > 0 ? parseFloat((totalScore / scoredChunks * 100).toFixed(1)) : null,
      chunks: chunks.length,
      originalWords: wordCount,
    });

  } catch (err) {
    console.error('[POST /humanize] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// START
// ============================================

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[Server] Port ${PORT}`);
  await startup();
});

process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err.message));
process.on('unhandledRejection', (reason) => console.error('[UNHANDLED]', reason));
process.on('SIGTERM', () => process.exit(0));