// A browser smoke test: starts the app, drives every screen in headless Chrome
// with the simulated bike, and fails on any script error.
//   node scripts/smoke.js
//
// It needs Chrome or Edge (set CHROME_PATH if it isn't found) and Node 22+,
// for the built-in WebSocket. It talks to the browser over the DevTools
// protocol, so there is nothing to install.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const APP_PORT = 5188;
const DEBUG_PORT = 9388;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((p) => p && existsSync(p));
}

const chromePath = findChrome();
if (!chromePath) {
  console.error('No Chrome or Edge found. Set CHROME_PATH to run the smoke test.');
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'pacer-smoke-'));
const server = spawn(process.execPath, [join(root, 'scripts/serve.js'), String(APP_PORT)], { stdio: 'ignore' });
const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--window-size=1280,1000',
  ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank',
], { stdio: 'ignore' });

const steps = [];
const errors = [];
let failed = null;

try {
  // Connect to the page.
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      target = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()).find((t) => t.type === 'page');
    } catch {
      // Chrome is still starting
    }
  }
  if (!target) throw new Error('Chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id) pending.get(msg.id)?.(msg.result ?? msg.error);
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    // "End the ride?" and "Delete this ride?": say yes.
    if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
  });
  await send('Runtime.enable');
  await send('Page.enable');

  const run = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
    return out.result?.value;
  };
  const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const text = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).innerText`);
  // A real mouse click, which the browser counts as a user gesture (the mini window needs one).
  const press = async (selector) => {
    const p = await run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  };
  const until = async (what, expression, ms = 20000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await run(expression)) return;
    throw new Error(`timed out waiting for ${what}`);
  };
  const check = async (name, fn) => {
    await fn();
    if (errors.length) throw new Error(`script error during "${name}": ${errors[0]}`);
    steps.push(name);
  };
  const expect = (ok, message) => { if (!ok) throw new Error(message); };

  await check('the app loads', async () => {
    await send('Page.navigate', { url: `http://localhost:${APP_PORT}/?speed=60` });
    await until('the app to start', `!!window.pacer && !document.getElementById('screen-setup').hidden`);
    expect((await text('#setup-title')) === 'Build a ride', 'setup screen is not showing');
  });

  await check('the four setup steps', async () => {
    for (let i = 0; i < 3; i++) await click('#step-next');
    expect(await run(`!document.querySelector('[data-step="3"]').hidden`), 'step 4 is not showing');
    await click('.step[data-go="1"]');
  });

  await check('choosing a ride, a random class and leaving a block out', async () => {
    await run(`(() => { const g = document.querySelector('[data-group="Spin class"]'); if (g.getAttribute('aria-expanded') !== 'true') g.click(); })()`);
    await click('[data-type="spinclass"]');
    await click('[data-type="spinclass"] [data-new-class]');
    const random = await text('#preview-code');
    await click('[data-block="sprints"]');
    const without = await text('#preview-code');
    expect(without.split('-').length === 4, `leaving a block out should extend the code, got ${without}`);
    await click('[data-block="sprints"]');
    expect((await text('#preview-code')) === random, 'putting the block back should restore the code');
    await click('[data-random]');
  });

  await check('effort and easy pace', async () => {
    await click('.step[data-go="2"]');
    await click('[data-pct="120"]');
    expect((await text('#effort-val')) === '120%', 'effort did not change');
    await click('[data-pct="100"]');
    await click('#btn-pace');
    await click('#pace-r-up');
    await click('#pace-save');
    expect(/resistance at \d+ rpm/.test(await text('#pace-chip')), 'easy pace is not shown');
  });

  await check('statistics and the calibration view', async () => {
    await click('#btn-stats');
    expect(/No rides yet/.test(await text('#stats-body')), 'expected an empty statistics page');
    await click('#btn-model');
    expect(await run(`document.getElementById('model-dialog').open`), 'calibration view did not open');
    await click('#model-close');
    await click('#btn-build');
  });

  await check('a simulated ride from start to summary', async () => {
    await click('#btn-sim');
    await until('the simulator to connect', `window.pacer.state.bikeState === 'connected'`);
    await run(`(() => { const s = window.pacer.state; s.type = 'intervals'; s.duration = 10; s.variant = 0; })()`);
    await click('.step[data-go="0"]');
    // Tapping a part of the preview says what it is.
    await run(`document.querySelector('#preview-chart rect[data-seg="0"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    expect(/^Warm-up[\s\S]*resistance/.test(await text('#preview-pick')), 'tapping the preview did not describe the warm-up');
    await press('#btn-start');
    await until('the ride to start', `window.pacer.state.screen === 'ride' && window.pacer.state.started`);
    expect(await run(`!!window.pacer.state.pipWin`), 'the mini window did not open');
    await until('the tiles to show readings', `Number(window.pacer.state.session.snapshot().cadence) > 0`);
    // Space pauses and resumes.
    await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))`);
    expect(await run(`window.pacer.state.paused`), 'space did not pause');
    await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))`);
    await until('the ride to finish', `window.pacer.state.screen === 'summary'`, 40000);
    expect((await text('#sum-eyebrow')) === 'Ride complete', 'the ride did not complete');
    expect(await run(`!!document.querySelector('#ride-chart svg path')`), 'the ride chart was not drawn');
    expect((await run(`document.querySelectorAll('#ride-blocks tbody tr').length`)) >= 3, 'expected a line for each part of the ride');
  });

  await check('the ride is saved, backed up and can be deleted', async () => {
    const backup = JSON.parse(await run(`window.pacer.storage.exportAll()`));
    expect(backup.app === 'pacer' && backup.rides.length === 1 && 'calibration' in backup, 'backup is missing something');
    await click('#btn-stats');
    expect((await run(`document.querySelectorAll('[data-delete]').length`)) === 1, 'expected one ride listed');
    await click('[data-delete]');
    expect(/No rides yet/.test(await text('#stats-body')), 'the ride was not deleted');
    await click('#btn-build');
  });

  await check('ending a ride early', async () => {
    await press('#btn-start');
    await until('the ride to start', `window.pacer.state.screen === 'ride' && window.pacer.state.started`);
    await click('#btn-end');
    await until('the summary', `window.pacer.state.screen === 'summary'`);
    expect((await text('#sum-eyebrow')) === 'Ride ended early', 'expected an early finish');
    await click('#btn-new');
  });

  await check('the ride pauses when the pedals stop, and carries on when they start', async () => {
    await run(`(() => { const s = window.pacer.state; s.type = 'endurance'; s.duration = 45; s.variant = 0; })()`);
    await click('.step[data-go="0"]');
    await press('#btn-start');
    await until('the ride to start', `window.pacer.state.screen === 'ride' && window.pacer.state.started`);
    await click('#sim-manual');
    await run(`window.pacer.state.bike.manualCadence = 0`);
    await until('the auto-pause', `window.pacer.state.autoPaused && window.pacer.state.paused`, 15000);
    await run(`window.pacer.state.bike.manualCadence = 85`);
    await until('the ride to carry on', `!window.pacer.state.paused`);
    await click('#sim-auto');
  });

  await check('an unfinished ride survives a reload', async () => {
    await until('progress to be saved', `!!window.pacer.storage.loadResume()`, 15000);
    const savedT = await run(`window.pacer.storage.loadResume().session.t`);
    await send('Page.navigate', { url: `http://localhost:${APP_PORT}/?speed=60` });
    await until('the app to start again', `!!window.pacer && !document.getElementById('screen-setup').hidden`);
    expect(await run(`!document.getElementById('resume-banner').hidden`), 'no offer to carry on');
    await click('#btn-sim');
    await until('the simulator to connect', `window.pacer.state.bikeState === 'connected'`);
    await press('#btn-resume');
    await until('the ride to resume', `window.pacer.state.screen === 'ride' && window.pacer.state.started`);
    expect((await run(`window.pacer.state.session.t`)) >= savedT, 'the ride restarted from the beginning');
    await click('#btn-end');
    await until('the summary', `window.pacer.state.screen === 'summary'`);
    expect((await run(`window.pacer.storage.loadResume()`)) === null, 'the finished ride is still offered');
    await click('#btn-new');
  });

  await check('the calibration dialog', async () => {
    await click('#btn-model');
    await click('#model-calibrate');
    expect(await run(`document.getElementById('calib').open`), 'calibration dialog did not open');
    await click('#calib-next');
    for (let i = 0; i < 9; i++) await click('#calib-skip');
    expect(/Not enough readings/.test(await text('#calib-body')), 'expected the "not enough readings" result');
    await click('#calib-cancel');
  });

  ws.close();
} catch (err) {
  failed = err;
} finally {
  chrome.kill();
  server.kill();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still be letting go of its profile
  }
}

for (const s of steps) console.log(`ok   ${s}`);
if (failed) {
  console.error(`FAIL ${failed.message}`);
  for (const e of errors) console.error(`     ${e}`);
  process.exit(1);
}
console.log(`\n${steps.length} checks passed`);
