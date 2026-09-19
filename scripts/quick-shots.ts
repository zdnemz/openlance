import { chromium } from "playwright-core";
async function main() {
  const browser = await chromium.launch({
    executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  });
  const shots: [string, string, number, number, boolean][] = [
    ["landing-desktop", "http://localhost:3000/", 1440, 900, true],
    ["landing-mobile", "http://localhost:3000/", 390, 844, false],
    ["dashboard", "http://localhost:3000/dashboard?persona=0", 1440, 900, false],
    ["project-room", "http://localhost:3000/projects/7c6b401d-fe17-444e-aa9d-99087807dede?persona=0", 1440, 900, false],
    ["arbiters", "http://localhost:3000/arbiters?persona=0", 1440, 900, false],
    ["jobs", "http://localhost:3000/jobs?persona=0", 1440, 900, false],
  ];
  for (const [name, url, w, h, full] of shots) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 60)));
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(10000);
      await page.screenshot({ path: `download/v2-${name}.png`, fullPage: full });
      console.log(`${name}: ok (${errors.length} errors)`);
    } catch (e) {
      console.log(`${name}: FAIL ${String(e).slice(0, 60)}`);
    }
    await page.close();
  }
  await browser.close();
}
void main();
