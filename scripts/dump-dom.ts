import { chromium } from "playwright-core";
import { writeFileSync } from "fs";
async function main() {
  const browser = await chromium.launch({
    executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto("http://localhost:3000/projects/7c6b401d-fe17-444e-aa9d-99087807dede?persona=0", {
    waitUntil: "domcontentloaded", timeout: 90000,
  });
  await page.waitForTimeout(14000);
  const html = await page.evaluate("document.documentElement.outerHTML");
  writeFileSync("public/dom-snapshot.html", "<!doctype html>" + html);
  console.log("dumped", html.length, "bytes");
  await browser.close();
}
void main();
