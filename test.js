const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const TEXT_TO_HUMANIZE = `Neuroplasticity refers to the brain remarkable ability 
to reorganize itself by forming new neural connections throughout life. 
This phenomenon is particularly significant during early childhood when 
synaptic pruning and myelination processes are most active. Research 
demonstrates that environmental stimulation directly influences cortical 
thickness and dendritic branching patterns across the lifespan.`;

(async () => {
  console.log('🚀 Launching stealth browser...');
  
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  page.on('console', msg => {
    if (msg.type() === 'error') console.log('🔴 PAGE ERROR:', msg.text());
  });

  console.log('🌐 Navigating...');
  await page.goto('https://www.humanizeai.pro', {
    waitUntil: 'networkidle2',
    timeout: 30000,
  });

  await new Promise(r => setTimeout(r, 2000));

  // Dismiss cookie banner
  try {
    const buttons = await page.$$('button');
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text.toLowerCase().includes('ok') || text.toLowerCase().includes('accept')) {
        await btn.click();
        console.log('🍪 Cookie dismissed');
        await new Promise(r => setTimeout(r, 1000));
        break;
      }
    }
  } catch (e) {}

  // Intercept API response
  page.on('response', async (response) => {
    if (response.url().includes('/api/process')) {
      console.log('📡 API status:', response.status());
      try {
        const json = await response.json();
        if (json?.result?.[0]?.text) {
          console.log('\n✅ HUMANIZED TEXT:');
          console.log('─'.repeat(60));
          console.log(json.result[0].text);
          console.log('─'.repeat(60));
          console.log(`📊 Human Score: ${(json.result[0].scores?.average * 100).toFixed(1)}%`);
        } else {
          console.log('📦 Response:', JSON.stringify(json, null, 2));
        }
      } catch (e) {
        const text = await response.text().catch(() => 'unreadable');
        console.log('⚠️ Non-JSON:', text.substring(0, 100));
      }
    }
  });

  // Type text
  console.log('✍️  Typing text...');
  await page.waitForSelector('textarea', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 1000));
  await page.evaluate((text) => {
    const textarea = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }, TEXT_TO_HUMANIZE);

  await new Promise(r => setTimeout(r, 2000));

  // Real mouse click
  console.log('🖱️  Clicking Humanize AI button...');
  const btnHandle = await page.evaluateHandle(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.find(b => b.textContent.trim() === 'Humanize AI');
  });

  const box = await btnHandle.asElement()?.boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    console.log('✅ Clicked! Waiting for response...');
  }

  await new Promise(r => setTimeout(r, 20000));
  await page.screenshot({ path: 'after_click.png' });
  await browser.close();
  console.log('🏁 Done.');
})();
