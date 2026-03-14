// server.js — Browserless.io + Job queue, fresh page per job
const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const EMAIL = process.env.HUMANIZE_EMAIL;
const PASSWORD = process.env.HUMANIZE_PASSWORD;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const IS_LOCAL = process.platform === 'darwin';

// ============================================
// JOB STORE
// ============================================
const jobs = new Map();

function makeJobId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 60 * 1000);

// ============================================
// QUEUE
// ============================================
let isBusy = false;
const queue = [];

function processQueue() {
  if (isBusy || queue.length === 0) return;
  const { jobId, text } = queue.shift();
  processJob(jobId, text);
}

// ============================================
// CHUNK TEXT
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

// ============================================
// GET BROWSER — fresh connection each time
// ============================================
async function getBrowser() {
  if (IS_LOCAL) {
    return puppeteer.launch({
      headless: true,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  if (!BROWSERLESS_TOKEN) throw new Error('BROWSERLESS_TOKEN not set');
  return puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io/?token=${BROWSERLESS_TOKEN}&timeout=120000`,
  });
}

// ============================================
// HUMANIZE ONE CHUNK — own browser session
// ============================================
async function humanizeChunk(text) {
  console.log('[Humanize] words:', text.split(/\s+/).length);

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Login if credentials provided
    if (EMAIL && PASSWORD) {
      console.log('[Humanize] Logging in...');
      await page.goto('https://www.humanizeai.pro/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await new Promise(r => setTimeout(r, 2000));

      await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
      await page.type('input[type="email"], input[name="email"]', EMAIL, { delay: 40 });
      await page.waitForSelector('input[type="password"]', { timeout: 5000 });
      await page.type('input[type="password"]', PASSWORD, { delay: 40 });

      const loginBtn = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(b =>
          b.textContent.toLowerCase().includes('log in') ||
          b.textContent.toLowerCase().includes('sign in') ||
          b.type === 'submit'
        );
      });
      const el = loginBtn.asElement();
      if (el) await el.click();
      else throw new Error('Login button not found');

      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 1500));
      console.log('[Humanize] Logged in, URL:', page.url());
    }

    // Navigate to humanizer
    console.log('[Humanize] Loading humanizer page...');
    await page.goto('https://www.humanizeai.pro', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    // Dismiss cookie banner
    try {
      const btns = await page.$$('button');
      for (const btn of btns) {
        const t = await page.evaluate(el => el.textContent.trim().toLowerCase(), btn);
        if (t === 'ok' || t === 'accept') {
          await btn.click();
          await new Promise(r => setTimeout(r, 800));
          break;
        }
      }
    } catch (e) {}

    // Wait for result via response interception
    const result = await new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout: no API response in 90s')), 90000);

      const responseHandler = async (response) => {
        if (response.url().includes('/api/process')) {
          console.log('[Humanize] /api/process status:', response.status());
          try {
            const json = await response.json();
            if (json?.result?.[0]?.text) {
              clearTimeout(timeout);
              page.off('response', responseHandler);
              resolve({ text: json.result[0].text, score: json.result[0].scores?.average ?? null });
            } else {
              console.log('[Humanize] Unexpected shape:', JSON.stringify(json).substring(0, 200));
            }
          } catch (e) {
            const raw = await response.text().catch(() => '');
            console.log('[Humanize] Non-JSON response:', raw.substring(0, 150));
            clearTimeout(timeout);
            page.off('response', responseHandler);
            reject(new Error('API returned non-JSON: ' + raw.substring(0, 80)));
          }
        }
      };

      page.on('response', responseHandler);

      try {
        await page.waitForSelector('textarea', { timeout: 15000 });
        await new Promise(r => setTimeout(r, 500));
        await page.evaluate((t) => {
          const textarea = document.querySelector('textarea');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(textarea, t);
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        }, text);

        await new Promise(r => setTimeout(r, 1500));

        const btnHandle = await page.evaluateHandle(() =>
          Array.from(document.querySelectorAll('button'))
            .find(b => b.textContent.trim() === 'Humanize AI')
        );
        const box = await btnHandle.asElement()?.boundingBox();
        if (box) {
          console.log('[Humanize] Clicking button...');
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          clearTimeout(timeout);
          page.off('response', responseHandler);
          reject(new Error('Humanize AI button not found'));
        }
      } catch (err) {
        clearTimeout(timeout);
        page.off('response', responseHandler);
        reject(err);
      }
    });

    return result;
  } finally {
    try {
      if (IS_LOCAL) await browser.close();
      else browser.disconnect();
    } catch (e) {}
  }
}

// ============================================
// PROCESS JOB
// ============================================
async function processJob(jobId, text) {
  const job = jobs.get(jobId);
  if (!job) return;
  isBusy = true;
  job.status = 'processing';
  console.log(`[Job ${jobId}] Processing...`);

  try {
    const chunks = chunkText(text, 190);
    const results = [];
    let totalScore = 0;
    let scoredChunks = 0;

    for (let i = 0; i < chunks.length; i++) {
      console.log(`[Job ${jobId}] Chunk ${i + 1}/${chunks.length}`);
      const result = await humanizeChunk(chunks[i]);
      results.push(result.text);
      if (result.score !== null) { totalScore += result.score; scoredChunks++; }
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 2000));
    }

    job.status = 'done';
    job.result = {
      humanized: results.join(' '),
      humanScore: scoredChunks > 0 ? parseFloat((totalScore / scoredChunks * 100).toFixed(1)) : null,
      chunks: chunks.length,
      originalWords: text.trim().split(/\s+/).length,
    };
    console.log(`[Job ${jobId}] Done ✅`);
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    console.error(`[Job ${jobId}] Error:`, err.message);
  } finally {
    isBusy = false;
    processQueue();
  }
}

// ============================================
// ROUTES
// ============================================
app.get('/', (req, res) => res.json({ status: 'ok' }));

app.get('/health', (req, res) => res.json({
  status: 'ready',
  busy: isBusy,
  queued: queue.length,
}));

app.get('/debug-token', (req, res) => {
  const token = process.env.BROWSERLESS_TOKEN || 'NOT SET';
  res.json({
    length: token.length,
    first10: token.substring(0, 10),
    last10: token.substring(token.length - 10),
    hasNewline: token.includes('\n'),
    hasSpace: token.includes(' '),
    raw: JSON.stringify(token), // shows hidden characters
  });
});


app.post('/humanize', (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text field is required' });
  }

  const jobId = makeJobId();
  jobs.set(jobId, { id: jobId, status: 'pending', result: null, error: null, createdAt: Date.now() });
  queue.push({ jobId, text: text.trim() });

  console.log(`[POST /humanize] Queued job ${jobId}`);
  processQueue();

  res.json({ jobId, status: 'pending', pollUrl: `/result/${jobId}` });
});

app.get('/result/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired (10min TTL)' });
  if (job.status === 'pending' || job.status === 'processing') {
    return res.json({ jobId: job.id, status: job.status });
  }
  if (job.status === 'error') {
    return res.status(500).json({ jobId: job.id, status: 'error', error: job.error });
  }
  return res.json({ jobId: job.id, status: 'done', ...job.result });
});

// ============================================
// START
// ============================================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Port ${PORT} — Ready ✅`);

  setInterval(() => {
    fetch(`http://localhost:${PORT}/health`)
      .then(() => console.log('[KeepAlive] ok'))
      .catch(e => console.warn('[KeepAlive] failed:', e.message));
  }, 4 * 60 * 1000);
});

server.setTimeout(10000);

process.on('uncaughtException', err => console.error('[UNCAUGHT]', err.message, err.stack));
process.on('unhandledRejection', reason => console.error('[UNHANDLED]', reason));
process.on('SIGTERM', () => process.exit(0));