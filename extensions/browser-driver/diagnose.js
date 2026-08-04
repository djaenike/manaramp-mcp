const path = require('path');
const { chromium } = require('playwright');

const URL = 'https://claude.ai/code/artifact/5d953120-5bc6-4efc-acfd-fc7c604bda40';
const PROFILE_DIR = path.join(__dirname, '.browser-profile');

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  console.log('=== TOP FRAME URL ===');
  console.log(page.url());
  console.log('=== PAGE TITLE ===');
  console.log(await page.title());

  console.log('=== ALL FRAMES ===');
  for (const frame of page.frames()) {
    console.log(frame.url());
  }

  console.log('=== Looking for #import-toggle-btn in each frame ===');
  for (const frame of page.frames()) {
    try {
      const el = await frame.$('#import-toggle-btn');
      console.log(frame.url(), '-> found:', !!el);
    } catch (e) {
      console.log(frame.url(), '-> error:', e.message);
    }
  }

  console.log('=== Login indicators on top frame ===');
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log(bodyText);

  console.log('Leaving browser open for 45s for manual inspection / login if needed...');
  await page.waitForTimeout(45000);
  await context.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
