import { chromium } from "playwright-core";
async function main() {
  const browser = await chromium.launch({
    executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("http://localhost:3000/projects/7c6b401d-fe17-444e-aa9d-99087807dede", {
    waitUntil: "domcontentloaded", timeout: 90000,
  });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: "tool-results/guest-a.png", fullPage: true });
  console.log("guest shot saved");
  await browser.close();
}
void main();
