import { chromium } from "playwright-core";
async function main() {
  const browser = await chromium.launch({
    executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("http://localhost:3000/projects/7c6b401d-fe17-444e-aa9d-99087807dede?persona=0", {
    waitUntil: "domcontentloaded", timeout: 90000,
  });
  await page.waitForTimeout(14000);
  const flat = await page.evaluate(`document.querySelectorAll('.border-y.border-line').length + '|' + document.querySelectorAll('.rounded-2xl.border.border-line').length`);
  console.log("flat-boxes|old-boxes:", flat);
  await browser.close();
}
void main();
