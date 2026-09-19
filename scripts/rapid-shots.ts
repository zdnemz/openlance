import { chromium } from "playwright-core";
async function main() {
  const browser = await chromium.launch({
    executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("http://localhost:3000/projects/7c6b401d-fe17-444e-aa9d-99087807dede?persona=0", {
    waitUntil: "commit", timeout: 90000,
  });
  for (let i = 0; i < 10; i++) {
    await page.screenshot({ path: `tool-results/race-${i}.png` });
    await page.waitForTimeout(700);
  }
  await browser.close();
  console.log("10 shots taken");
}
void main();
