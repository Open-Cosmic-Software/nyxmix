// Usage: node test/shot.mjs <url> <out.png> [actions-json]
import { chromium } from 'playwright';
const [url, out, actions = '[]'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: Number(process.env.SHOT_SCALE) || 1, colorScheme: process.env.SHOT_SCHEME || 'light' });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'networkidle' });
for (const a of JSON.parse(actions)) {
  if (a.wait) await page.waitForTimeout(a.wait);
  if (a.click) await page.click(a.click);
  if (a.key) await page.keyboard.press(a.key);
  if (a.mouse) { const [x, y] = a.mouse; await page.mouse.click(x, y, a.opts || {}); }
  if (a.drag) { const [x1, y1, x2, y2] = a.drag; await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 8 }); await page.mouse.up(); }
  if (a.eval) logs.push('[eval] ' + JSON.stringify(await page.evaluate(a.eval)));
}
await page.waitForTimeout(800);
await page.screenshot({ path: out });
console.log(logs.join('\n'));
await browser.close();
