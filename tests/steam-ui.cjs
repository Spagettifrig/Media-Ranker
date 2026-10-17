// Hidden, isolated Electron integration test against the built production UI.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

let win;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function run(code) { return win.webContents.executeJavaScript(code); }
async function until(code, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await run(code)) return; await delay(60); }
  throw new Error(`Timed out: ${code}\n${await run('document.body.innerText')}`);
}
async function click(text) {
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(text)} && !b.disabled)`);
  await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
  await delay(100);
}
async function profile(value) {
  await run(`(()=>{const input=document.querySelector('input[placeholder="steamcommunity.com/id/yourname"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function screenshot(filename) {
  // A hidden window can have an older compositor frame despite current DOM.
  await win.webContents.capturePage();
  await delay(250);
  await fs.writeFile(filename, (await win.webContents.capturePage()).toPNG());
}

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'game-ranker-steam-ui-'));
  app.setPath('userData', temp);
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1440, height: 1000,
    webPreferences: { preload: path.join(__dirname, 'steam-ui-preload.cjs'), contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
  await win.loadFile(path.join(__dirname, '../dist/index.html'));
  await click('Import games');
  await until(`document.body.innerText.includes('Import all from Fixture Player')`);
  const startShot = path.join(temp, 'steam-start.png');
  await screenshot(startShot);
  await profile('private-user');
  await click('Choose games first');
  await until(`document.querySelector('[role="alert"]')?.textContent.includes('Game details')`);
  await profile('fixture-user');
  await click('Choose games first');
  await until(`document.body.innerText.includes('84 games returned')`);
  assert.equal(await run(`document.querySelectorAll('.steam-import__row').length`), 75);
  assert.equal(await run(`document.querySelector('.steam-import__row input:disabled') !== null`), true);
  const previewShot = path.join(temp, 'steam-preview.png');
  await screenshot(previewShot);
  await click('Next');
  assert.equal(await run(`document.querySelectorAll('.steam-import__row').length`), 9);
  await run(`document.querySelector('.steam-import__toolbar input[type="checkbox"]').click()`);
  await delay(100);
  await click('Select shown (1)');
  await click('Import 1 games');
  await until(`document.body.innerText.includes('1 game added to Unrated.')`);
  await run(`document.querySelector('[aria-label="Close Steam import"]').click()`);
  await until(`document.body.innerText.includes('Unrated (1)')`);
  await delay(350);
  let saved = await run(`window.__steamTest.getSaved()`);
  assert.equal(saved.libraries.games.length, 3);
  const dota = saved.libraries.games.find((game) => game.steamAppId === '570');
  assert.equal(dota.unrated, true);
  assert.equal(dota.overallScore, null);
  assert.equal(dota.hoursPlayed, 123.4);
  assert.equal(saved.libraries.games[0].descriptions.overall, 'Keep this note');
  assert.equal(saved.libraries.games[0].hoursPlayed, 42);
  assert.equal(saved.libraries.games[0].overallScore, 90);
  await click('Stats');
  assert.ok(!(await run('document.body.innerText')).includes('Dota 2'));
  await click('Compare');
  assert.ok(!(await run('document.body.innerText')).includes('Dota 2'));
  await click('Board');
  await run(`document.querySelector('[aria-label="Dota 2, unrated"]').click()`);
  await until(`document.body.innerText.includes('Unrated — your scores are a draft')`);
  await run(`document.querySelector('.unrated-notice').scrollIntoView({block:'center'})`);
  await screenshot(path.join(temp, 'steam-unrated.png'));
  await click('Finish rating');
  await until(`document.body.innerText.includes('OVERALL SCORE')`);
  await delay(350);
  saved = await run(`window.__steamTest.getSaved()`);
  assert.equal(saved.libraries.games.find((game) => game.steamAppId === '570').unrated, false);
  assert.equal(saved.libraries.games.find((game) => game.steamAppId === '570').rank, 3);
  await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await click('Import games');
  await profile('fixture-user');
  await click('Choose games first');
  await until(`document.body.innerText.includes('2 already in your library')`);
  // Exercise partial cancellation on a large library; committed batch must survive.
  await click('Clear selection');
  await click('Select shown (81)');
  await run('window.__steamTest.importDelay = 250');
  await click('Import 81 games');
  await click('Stop after current batch');
  await until(`document.body.innerText.includes('Stopped; completed imports are kept.')`);
  await delay(350);
  saved = await run(`window.__steamTest.getSaved()`);
  assert.equal(saved.libraries.games.length, 13);
  assert.equal(await run('window.__steamTest.pushes.length'), 0);
  // One-step import from the account detected on this PC: adds the rest, refreshes Steam playtime only.
  await run(`document.querySelector('[aria-label="Close Steam import"]').click()`);
  await run('window.__steamTest.importDelay = 0; window.__steamTest.bumpDota()');
  await click('Import games');
  await click('Import all from Fixture Player');
  await until(`document.body.innerText.includes('games added to Unrated.')`);
  assert.ok((await run('document.body.innerText')).includes('Playtime updated for 1 game already in your library.'));
  assert.ok((await run('document.body.innerText')).includes('1 game has a similar title'));
  await delay(350);
  saved = await run(`window.__steamTest.getSaved()`);
  assert.equal(saved.libraries.games.length, 84);
  assert.equal(saved.libraries.games.find((game) => game.steamAppId === '570').hoursPlayed, 200);
  assert.equal(saved.libraries.games.find((game) => game.id === 'existing').hoursPlayed, 42);
  assert.equal(saved.libraries.games.find((game) => game.id === 'manual').hoursPlayed, 42);
  assert.equal(await run(`localStorage.getItem('steamImport.profile')`), '76561198000000000');
  await click('Import new games');
  await until(`document.body.innerText.includes('Your library is up to date')`);
  // PlayStation and Xbox: one sign-in imports everything new, with platform tags.
  await click('PlayStation');
  await click('Sign in and import all');
  await until(`document.body.innerText.includes('1 game added to Unrated.')`);
  assert.ok((await run('document.body.innerText')).includes('1 game was skipped because a game with the same title'));
  await click('Sign in and import all');
  await until(`document.body.innerText.includes('no new PlayStation games to add')`);
  await click('Xbox');
  await click('Sign in and import all');
  await until(`document.body.innerText.includes('1 game added to Unrated.')`);
  await delay(350);
  saved = await run(`window.__steamTest.getSaved()`);
  const astro = saved.libraries.games.find((game) => game.storeIds?.psn === '77');
  assert.equal(astro.hoursPlayed, 12.5);
  assert.deepEqual(astro.platforms, ['ps5']);
  assert.deepEqual(saved.libraries.games.find((game) => game.storeIds?.xbox === '219630713').platforms, ['pc', 'xboxseries']);
  assert.equal(saved.libraries.games.length, 86);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ ok: true, checks: 'private profile, 84-game pagination, selection, import, saved unrated state, excluded stats/compare, finish rating, duplicate retry, partial cancellation, detected account one-step import, playtime refresh, up-to-date rerun, PlayStation and Xbox one-step import', screenshots: [startShot, previewShot, path.join(temp, 'steam-unrated.png')] }, null, 2));
  win.destroy();
  app.exit(0);
})().catch((error) => { console.error(error); if (win) win.destroy(); app.exit(1); });
