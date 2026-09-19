/** Probe the live DOM for elements whose computed transition includes height. */
import { chromium } from "playwright-core";

async function main() {
  const browser = await chromium.launch({
    executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  });
  const page = await browser.newPage();
  await page.goto("http://localhost:3000/dashboard?persona=0", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2000);
  const culprits = await page.evaluate(() => {
    const out: { tag: string; cls: string; transition: string; text: string }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      const t = getComputedStyle(el).transitionProperty;
      if (t.split(",").some((p) => p.trim() === "height" || p.trim() === "all")) {
        out.push({
          tag: el.tagName,
          cls: el.className?.toString().slice(0, 120) ?? "",
          transition: t.slice(0, 60),
          text: el.textContent?.slice(0, 40) ?? "",
        });
      }
    }
    return out;
  });
  console.log(JSON.stringify(culprits, null, 1).slice(0, 3000));
  await browser.close();
}
void main();
