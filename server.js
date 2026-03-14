// server.js
// Humanize AI Pro — Express + Puppeteer server
// Logs in once on startup, keeps session alive, chunks text ≤198 words

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const EMAIL = process.env.HUMANIZE_EMAIL;
const PASSWORD = process.env.HUMANIZE_PASSWORD;

let browser = null;
let page = null;
let isLoggedIn = false;
let isReady = false;

// ============================================
// CHUNK TEXT INTO ≤198 WORD PIECES
// ============================================

function chunkText(text, maxWords = 198) {
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
// INIT BROWSER
// ============================================

async function initBrowser() {
  console.log('[Browser] Launching...');
  browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  console.log('[Browser] Launched');
}

// ============================================
// LOGIN
// ============================================

async function login() {
  console.log('[Login] Navigating to login page...');
  await page.goto('https://www.humanizeai.pro/login', {
    waitUntil: 'networkidle2',
    timeout: 30000,
  });
  await new Promise(r => setTimeout(r, 2000));

  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
  await page.type('input[type="email"], input[name="email"]', EMAIL, { delay: 50 });

  await page.waitForSelector('input[type="password"]', { timeout: 5000 });
  await page.type('input[type="password"]', PASSWORD, { delay: 50 });

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

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
  await new Promise(r => setTimeout(r, 2000));

  const url = page.url();
  if (url.includes('login')) throw new Error('Login failed — check credentials');

  isLoggedIn = true;
  console.log('[Login] Success. URL:', url);
}

// ============================================
// HUMANIZE A SINGLE CHUNK
// ============================================

async function humanizeChunk(text) {
  console.log(`[Humanize] Chunk: ${text.split(/\s+/).length} words`);

  const currentUrl = page.url();
  if (!currentUrl.includes('humanizeai.pro') || currentUrl.includes('login')) {
    await page.goto('https://www.humanizeai.pro', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
  }

  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout: no response in 30s')), 30000);

    const responseHandler = async (response) => {
      if (response.url().includes('/api/process')) {
        try {
          const json = await response.json();
          if (json?.result?.[0]?.text) {
            clearTimeout(timeout);
            page.off('response', responseHandler);
            resolve({
              text: json.result[0].text,
              score: json.result[0].scores?.average ?? null,
            });
          }
        } catch (e) {}
      }
    };

    page.on('response', responseHandler);

    try {
      await page.waitForSelector('textarea', { timeout: 10000 });
      await new Promise(r => setTimeout(r, 500));

      await page.evaluate((t) => {
        const textarea = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(textarea, t);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      }, text);

      await new Promise(r => setTimeout(r, 1500));

      const btnHandle = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(b => b.textContent.trim() === 'Humanize AI');
      });

      const box = await btnHandle.asElement()?.boundingBox();
      if (box) {
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
}

// ============================================
// STARTUP
// ============================================

async function startup() {
  try {
    await initBrowser();
    await login();
    isReady = true;
    console.log('[Server] Ready ✅');
  } catch (err) {
    console.error('[Startup] Failed:', err.message);
    process.exit(1);
  }
}

// ============================================
// ROUTES
// ============================================

app.get('/health', (req, res) => {
  res.json({ status: isReady ? 'ready' : 'starting', loggedIn: isLoggedIn });
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
    const chunks = chunkText(text, 198);
    console.log(`[POST /humanize] ${chunks.length} chunk(s)`);

    const results = [];
    let totalScore = 0;
    let scoredChunks = 0;

    for (let i = 0; i < chunks.length; i++) {
      console.log(`[POST /humanize] Chunk ${i + 1}/${chunks.length}`);
      const result = await humanizeChunk(chunks[i]);
      results.push(result.text);
      if (result.score !== null) {
        totalScore += result.score;
        scoredChunks++;
      }
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 2000));
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

app.listen(PORT, async () => {
  console.log(`[Server] Port ${PORT}`);
  await startup();
});

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});