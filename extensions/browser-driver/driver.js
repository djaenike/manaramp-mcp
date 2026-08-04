// Attaches to the SAME Chrome window the user opens by double-clicking open-playtest-chrome.bat
// (launched with --remote-debugging-port=9222), rather than spawning a separate hidden browser.
// That means the user's own clicks and Claude's automated clicks land on one shared live page —
// no divergent state, no login wall (it's a local file, not the claude.ai-hosted artifact).
const http = require('http');
const { chromium } = require('playwright');

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const PAGE_TITLE_MATCH = 'Playtest Table';
const PORT = Number(process.env.DRIVER_PORT || 8765);

const ZONE_LABELS = {
  battlefield: 'Battlefield', hand: 'Hand', command: 'Command zone',
  graveyard: 'Graveyard', exile: 'Exile', library: 'Library (top)'
};

let browser, page;

async function ensureBrowser() {
  if (page && !page.isClosed()) return;
  if (!browser || !browser.isConnected()) {
    browser = await chromium.connectOverCDP(CDP_URL);
  }
  const contexts = browser.contexts();
  let found = null;
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      if ((await p.title()).indexOf(PAGE_TITLE_MATCH) !== -1) { found = p; break; }
    }
    if (found) break;
  }
  if (!found) {
    throw new Error(
      'No open tab titled "' + PAGE_TITLE_MATCH + '" found on ' + CDP_URL +
      '. Open extensions/browser-driver/open-playtest-chrome.bat first, or open the file manually in that Chrome window.'
    );
  }
  page = found;
  await page.bringToFront();
  await page.waitForTimeout(500);
}

function rowSel(player) {
  if (player !== 'you' && player !== 'ai') throw new Error('player must be "you" or "ai", got: ' + player);
  return '#row-' + player;
}

function cardSelInRow(player, zone, cardName) {
  const nameAttr = '[data-name="' + cardName.replace(/"/g, '\\"') + '"]';
  const playerAttr = '[data-player="' + player + '"]';
  // Battlefield permanents live in the shared #shared-battlefield section (not each player's own
  // row), split visually into AI/You halves but both selected the same way via data-player.
  if (zone === 'battlefield') return '#shared-battlefield [data-role="bf-card"]' + playerAttr + nameAttr;
  const row = rowSel(player);
  if (zone === 'command') return row + ' [data-role="cmd-card"]' + nameAttr;
  return row + ' [data-role="mini-card"][data-zone="' + zone + '"]' + nameAttr;
}

async function openZoneMenuFor(player, fromZone, cardName) {
  const cardSel = cardSelInRow(player, fromZone, cardName);
  const card = page.locator(cardSel).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });
  if (fromZone === 'battlefield') {
    await card.locator('[data-role="bf-menu"]').click();
  } else {
    await card.click();
  }
  await page.locator('#zone-menu-popover').waitFor({ state: 'visible', timeout: 3000 });
}

async function moveCard({ player, cardName, fromZone, toZone }) {
  if (!ZONE_LABELS[toZone]) throw new Error('unknown toZone: ' + toZone);
  await openZoneMenuFor(player, fromZone, cardName);
  const label = ZONE_LABELS[toZone];
  const btn = page.locator('#zone-menu-popover button', { hasText: label }).first();
  await btn.waitFor({ state: 'visible', timeout: 3000 });
  await btn.click();
  return { moved: cardName, from: fromZone, to: toZone, player };
}

async function castCommander({ player, cardName }) {
  const sel = cardSelInRow(player, 'command', cardName);
  const card = page.locator(sel).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });
  await card.click();
  return { cast: cardName, player };
}

async function toggleTapTo({ player, cardName, tapped }) {
  const sel = cardSelInRow(player, 'battlefield', cardName);
  const card = page.locator(sel).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });
  const classAttr = (await card.getAttribute('class')) || '';
  const isTapped = classAttr.indexOf('tapped') !== -1;
  if (isTapped !== !!tapped) {
    await card.click();
  }
  return { cardName, player, tapped: !!tapped };
}

async function draw({ player }) {
  await page.locator(rowSel(player) + ' [data-role="lib-draw"]').click();
  return { drew: player };
}

async function shuffleLibrary({ player }) {
  await page.locator(rowSel(player) + ' [data-role="lib-shuffle"]').click();
  return { shuffled: player };
}

async function openingHand({ player }) {
  await page.locator(rowSel(player) + ' [data-role="opening-hand"]').click();
  return { openingHand: player };
}

async function mulligan({ player }) {
  await page.locator(rowSel(player) + ' [data-role="mulligan"]').click();
  return { mulligan: player };
}

async function adjustLife({ player, delta }) {
  const n = Number(delta);
  if (!Number.isInteger(n)) throw new Error('delta must be an integer');
  const sel = rowSel(player) + (n >= 0 ? ' [data-role="life-inc"]' : ' [data-role="life-dec"]');
  const clicks = Math.abs(n);
  for (let i = 0; i < clicks; i++) {
    await page.locator(sel).click();
  }
  return { player, delta: n };
}

async function passTurn() {
  await page.locator('#pass-turn-btn').click();
  return { passed: true };
}

async function loadPreset({ player, presetLabelContains }) {
  const panel = page.locator('#import-panel');
  if (!(await panel.isVisible())) {
    await page.locator('#import-toggle-btn').click();
    await panel.waitFor({ state: 'visible', timeout: 3000 });
  }
  await page.locator('#import-player-select').selectOption(player);
  const options = await page.locator('#preset-select option').allTextContents();
  const idx = options.findIndex((t) => t.toLowerCase().indexOf(presetLabelContains.toLowerCase()) !== -1);
  if (idx === -1) throw new Error('no preset matches "' + presetLabelContains + '". Options: ' + options.join(' | '));
  await page.locator('#preset-select').selectOption({ index: idx });
  await page.locator('#preset-load-btn').click();
  return { player, loadedPreset: options[idx] };
}

async function getState() {
  const state = await page.evaluate(() => window.__playtestState || null);
  if (!state) throw new Error('window.__playtestState not found yet — has the page rendered at least once?');
  return state;
}

async function screenshotBase64() {
  const buf = await page.screenshot({ fullPage: true });
  return buf.toString('base64');
}

const ACTIONS = {
  moveCard, castCommander,
  tap: (args) => toggleTapTo({ ...args, tapped: true }),
  untap: (args) => toggleTapTo({ ...args, tapped: false }),
  draw, shuffleLibrary, openingHand, mulligan, adjustLife, passTurn, loadPreset,
  reload: async () => { await page.reload({ waitUntil: 'domcontentloaded' }); return { reloaded: true }; },
  focus: async () => { await page.bringToFront(); return { focused: true }; },
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    await ensureBrowser();

    if (req.method === 'GET' && req.url === '/status') {
      return send(res, 200, { ok: true, url: page.url(), title: await page.title() });
    }
    if (req.method === 'GET' && req.url === '/state') {
      return send(res, 200, { ok: true, state: await getState() });
    }
    if (req.method === 'GET' && req.url === '/screenshot') {
      return send(res, 200, { ok: true, png_base64: await screenshotBase64() });
    }
    if (req.method === 'POST' && req.url === '/command') {
      const body = await readJsonBody(req);
      const fn = ACTIONS[body.action];
      if (!fn) return send(res, 400, { ok: false, error: 'unknown action: ' + body.action, available: Object.keys(ACTIONS) });
      const result = await fn(body);
      return send(res, 200, { ok: true, result: result });
    }
    send(res, 404, { ok: false, error: 'no such route' });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log('driver listening on http://127.0.0.1:' + PORT);
  try {
    await ensureBrowser();
    console.log('browser ready, page url:', page.url());
    console.log('page title:', await page.title());
  } catch (e) {
    console.error('startup error:', e.message);
  }
});

// browser.close() on a CDP-attached connection disconnects Playwright only — it does NOT close
// the user's actual Chrome window, since we never launched it.
process.on('SIGINT', async () => { try { await browser.close(); } catch (e) {} process.exit(0); });
