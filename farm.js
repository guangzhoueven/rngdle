const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SITE = 'https://rngdle.com';
const OUT_DIR = path.join(__dirname, 'output');
const MYTHIC_MIN_SCORE = 162292; // first score whose percentile >= 99 (Top 1%)
const TARGET = Math.max(1, Number(process.env.TARGET) || 10); // how many Top 1% rolls to collect
const WORKERS = Math.max(1, Number(process.env.WORKERS) || 4);
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES) || 30);
const HEADLESS = process.env.HEADLESS !== '0';

const pctTable = JSON.parse(fs.readFileSync(path.join(__dirname, 'SCORE_PERCENTILES.json'), 'utf8'));
const pctKeys = Object.keys(pctTable).map(Number).sort((a, b) => a - b);

function percentileFor(score) {
  if (pctTable[score] !== undefined) return pctTable[score];
  let lo = 0, hi = pctKeys.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pctKeys[mid] <= score) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best < 0 ? 0 : pctTable[pctKeys[best]];
}

function cardTier(pct) {
  if (pct < 1) return 'TRASH';
  if (pct < 50) return 'COMMON';
  if (pct < 75) return 'UNCOMMON';
  if (pct < 90) return 'RARE';
  if (pct < 95) return 'EPIC';
  if (pct < 99) return 'ANOMALY';
  return 'MYTHIC';
}

function formatPercentile(p) {
  if (p >= 50) {
    const t = Math.round(100 - p);
    return `Top ${t === 0 ? '<1' : t}%`;
  }
  const t = Math.round(p);
  return `Bottom ${t === 0 ? '<1' : t}%`;
}

function badgeTier(score) {
  if (score < 1e3) return 'COMMON';
  if (score < 1e4) return 'UNCOMMON';
  if (score < 1e5) return 'RARE';
  if (score < 1e6) return 'EPIC';
  if (score < 1e7) return 'ANOMALY';
  return 'MYTHIC';
}

const TIER_EMOJI = { TRASH: '🟫', COMMON: '⬜', UNCOMMON: '🟩', RARE: '🟦', EPIC: '🟪', ANOMALY: '🟧', MYTHIC: '🟥' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = n => n.toLocaleString('en-US');
const pad2 = n => String(n).padStart(2, '0');

function log(msg) { console.log(msg); }

async function rollOnce(page) {
  await page.evaluate(() => {
    localStorage.removeItem('rngdle_guest_roll_data');
    localStorage.removeItem('rngdle_guest_roll_date');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button:has-text("GENERATE")', { timeout: 20000 });
  await page.click('button:has-text("GENERATE")');
  await page.waitForFunction(() => !!localStorage.getItem('rngdle_guest_roll_data'), null, { timeout: 20000 });
  const raw = await page.evaluate(() => localStorage.getItem('rngdle_guest_roll_data'));
  return JSON.parse(raw);
}

async function gotoWithRetry(page, tries = 4) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('body', { timeout: 15000 });
      return;
    } catch (err) {
      lastErr = err;
      log(`  goto retry ${i}/${tries}: ${String(err.message).split('\n')[0]}`);
      await sleep(1500 * i);
    }
  }
  throw lastErr;
}

async function readTierRow(page) {
  return page.evaluate(() => {
    const bullet = [...document.querySelectorAll('span')].find(s => s.textContent.trim() === '•');
    if (!bullet) return null;
    return {
      tier: bullet.previousElementSibling ? bullet.previousElementSibling.textContent.trim() : null,
      percentile: bullet.nextElementSibling ? bullet.nextElementSibling.textContent.trim() : null,
    };
  });
}

async function readLifetimeEp(page) {
  return page.evaluate(() => {
    const label = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim() === 'YOUR LIFETIME EP');
    if (!label || !label.parentElement) return null;
    const first = label.parentElement.innerText.split('\n').map(s => s.trim()).filter(Boolean)[0];
    return first || null;
  }).catch(() => null);
}

function writeOutputs(state, startedAt) {
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    site: SITE,
    generatedAt: new Date().toISOString(),
    target: state.target,
    collected: state.mythics.length,
    attempts: state.attempts,
    workers: WORKERS,
    errors: state.errors,
    elapsedSeconds: elapsedSec,
    rolls: state.mythics,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'collection.json'), JSON.stringify(payload, null, 2), 'utf8');

  const txt = [
    `RNGdle Top 1% Collection — ${state.mythics.length}/${state.target}`,
    '==================================================',
    `Updated       : ${payload.generatedAt}`,
    `Attempts      : ${state.attempts} (${WORKERS} workers, ${state.errors} errors)`,
    `Elapsed       : ${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`,
    `Mythic rule   : EP >= ${fmt(MYTHIC_MIN_SCORE)} (percentile >= 99)`,
    '',
    'Collected rolls:',
    '  #   Attempt    Number           EP  Percentile  Tier',
    ...state.mythics.map(r =>
      `  ${pad2(r.index)}  #${String(r.attempt).padStart(6)}  ${String(r.number).padStart(6)}  ${fmt(r.totalScore).padStart(12)}  ${r.percentile.toFixed(4).padStart(9)}  ${r.tierLabel || r.tier} ${r.percentileText || ''}`
    ),
    '',
    'Screenshots:',
    ...state.mythics.map(r => `  ${pad2(r.index)}. ${r.screenshot || '(capturing...)'}`),
    '',
    'Highlights:',
    ...state.mythics.map(r =>
      `  ${pad2(r.index)}. ${r.number} — ${(r.badges || []).slice(0, 3).map(b => `${b.emoji} ${b.label} +${fmt(b.score)}`).join(', ') || 'capturing...'}`
    ),
    '',
    `JSON: ${path.join(OUT_DIR, 'collection.json')}`,
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'collection.txt'), txt, 'utf8');
}

async function recordMythic(state, startedAt, w) {
  const index = state.mythics.length + 1;
  const entry = {
    index,
    number: w.roll.number,
    totalScore: w.roll.totalScore,
    percentile: Number(w.pct.toFixed(4)),
    tier: w.tier,
    tierLabel: null,
    percentileText: null,
    worker: w.id,
    attempt: w.attempt,
    capturedAt: null,
    lifetimeEp: null,
    badgeCount: 0,
    badges: [],
    screenshot: null,
    shareText: null,
  };
  state.mythics.push(entry); // reserve index synchronously before any await
  log(`\n>>> MYTHIC ${index}/${state.target} at attempt #${w.attempt}: ${w.roll.number} (${fmt(w.roll.totalScore)} EP) — capturing...`);

  const page = w.page;
  await page.waitForFunction(() => document.body.innerText.includes('MYTHIC'), null, { timeout: 90000 })
    .catch(() => log('warning: tier label did not appear within 90s'));

  const tierRow = await readTierRow(page);
  let lifetimeEp = await readLifetimeEp(page);
  const domText = await page.evaluate(() => document.body.innerText);
  if (!lifetimeEp) {
    const m = domText.match(/([\d,]+)\s*EP\s*\n([\d,]+)\s*EP\s*\nYOUR LIFETIME EP/);
    if (m) lifetimeEp = m[2];
  }

  await page.evaluate(() => {
    const sc = document.querySelector('[data-page-scroll-container]');
    if (sc) sc.scrollTop = 0;
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.setViewportSize({ width: 1280, height: 1700 });
  await sleep(600);

  const shotPath = path.join(OUT_DIR, `mythic_${pad2(index)}.png`);
  await page.screenshot({ path: shotPath, fullPage: true });

  const badges = w.roll.badges.map(b => ({
    emoji: b.emoji || '✨',
    label: b.label,
    rarity: badgeTier(b.score),
    score: b.score,
    scoring: !!b.isScoring,
    description: b.description,
  }));
  const shareLines = [
    `RNGdle 🎲 ${w.roll.number}`,
    '',
    `${TIER_EMOJI[w.tier]} ${tierRow?.tier || w.tier}${tierRow?.percentile ? ' • ' + tierRow.percentile : ''}`,
    '',
    ...badges.slice(0, 3).map(b => `${TIER_EMOJI[b.rarity]} ${b.emoji} ${b.label}`),
    ...(badges.length > 3 ? [`+${badges.length - 3} more`] : []),
  ];

  Object.assign(entry, {
    tierLabel: tierRow?.tier || w.tier,
    percentileText: tierRow?.percentile || formatPercentile(w.pct),
    lifetimeEp,
    badgeCount: badges.length,
    badges,
    screenshot: shotPath,
    shareText: shareLines.join('\n'),
    capturedAt: new Date().toISOString(),
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    pageTextTop: domText.split('\n').slice(0, 30).join('\n'),
  });

  writeOutputs(state, startedAt);
  log(`saved ${shotPath} — collected ${state.mythics.length}/${state.target}\n`);
}

async function runWorker(browser, id, state, startedAt) {
  let context = null;
  try {
    await sleep((id - 1) * 500);
    context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    await gotoWithRetry(page);
    while (state.mythics.length < state.target && Date.now() < state.deadline) {
      try {
        const roll = await rollOnce(page);
        state.attempts++;
        const pct = percentileFor(roll.totalScore);
        const tier = cardTier(pct);
        log(`[w${id}] #${String(state.attempts).padStart(4)} roll=${String(roll.number).padStart(6)} EP=${fmt(roll.totalScore).padStart(9)} pct=${pct.toFixed(2).padStart(6)}% ${tier}  [${state.mythics.length}/${state.target}]`);
        if (roll.totalScore >= MYTHIC_MIN_SCORE && pct >= 99) {
          await recordMythic(state, startedAt, { id, page, roll, pct, tier, attempt: state.attempts });
        }
      } catch (err) {
        state.errors++;
        log(`[w${id}] error (${state.errors}): ${String(err.message).split('\n')[0]}`);
        await sleep(1200);
        try { await gotoWithRetry(page, 2); } catch (e2) {
          log(`[w${id}] recovery failed: ${String(e2.message).split('\n')[0]}`);
          break;
        }
      }
    }
  } catch (err) {
    state.deadWorkers++;
    log(`[w${id}] worker stopped: ${String(err.message).split('\n')[0]}`);
  } finally {
    if (context) {
      try { await context.close(); } catch (_) {}
    }
  }
}

function clearPreviousOutputs() {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (/^mythic_\d+\.png$/.test(f) || f.startsWith('collection.') || f.startsWith('top1') || f.startsWith('result.')) {
        fs.unlinkSync(path.join(OUT_DIR, f));
      }
    }
  } catch (_) {}
}

(async () => {
  const startedAt = Date.now();
  const state = { attempts: 0, errors: 0, deadWorkers: 0, mythics: [], target: TARGET, deadline: startedAt + MAX_MINUTES * 60000 };
  clearPreviousOutputs();
  log(`RNGdle farm | target=${TARGET} mythics | workers=${WORKERS} headless=${HEADLESS} limit=${MAX_MINUTES}m`);
  log(`Goal: collect ${TARGET} rolls with EP >= ${fmt(MYTHIC_MIN_SCORE)} (percentile >= 99 = MYTHIC = Top 1%)\n`);

  const browser = await chromium.launch({ headless: HEADLESS });
  try {
    await Promise.allSettled(
      Array.from({ length: WORKERS }, (_, i) => runWorker(browser, i + 1, state, startedAt))
    );
    writeOutputs(state, startedAt);

    const got = state.mythics.length;
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    if (got >= TARGET) {
      log(`\nDONE: ${got}/${TARGET} Top 1% rolls in ${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s (${state.attempts} attempts, ${state.errors} errors)`);
      for (const r of state.mythics) {
        log(`  ${pad2(r.index)}. ${String(r.number).padStart(6)}  ${fmt(r.totalScore).padStart(9)} EP  ${r.tierLabel} ${r.percentileText}  -> ${path.basename(r.screenshot)}`);
      }
      log(`Saved: ${path.join(OUT_DIR, 'collection.txt')}`);
      log(`Saved: ${path.join(OUT_DIR, 'collection.json')}`);
    } else if (state.deadWorkers >= WORKERS) {
      log(`\nAll workers stopped. Collected ${got}/${TARGET} after ${state.attempts} attempts (${state.errors} errors).`);
      process.exitCode = 1;
    } else {
      log(`\nTimeout: collected ${got}/${TARGET} within ${MAX_MINUTES} minutes (${state.attempts} attempts). Raise MAX_MINUTES or WORKERS.`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close().catch(() => {});
  }
})();
