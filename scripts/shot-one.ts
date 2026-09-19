import { chromium } from "playwright-core";
const [name, url, w, h] = process.argv.slice(2);
async function main() {
  const browser = await chromium.launch({
    executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  });
  const page = await browser.newPage({ viewport: { width: +w, height: +h } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 50)));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(10000);
  await page.screenshot({ path: `download/v2-${name}.png` });
  console.log(`${name}: ok (${errors.length} errors)`);
  await browser.close();
}
void main();
