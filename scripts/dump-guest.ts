import { chromium } from "playwright-core";
import { writeFileSync } from "fs";
async function main() {
  const browser = await chromium.launch({
    executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto("http://localhost:3000/dom-snapshot.html", { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(9000);
  const html = await page.evaluate("document.documentElement.outerHTML");
  const frozen = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "").replace(/<script[^>]*\/>/g, "");
  writeFileSync("public/dom-guest.html", "<!doctype html>" + frozen);
  console.log("dumped guest", frozen.length);
  await browser.close();
}
void main();
