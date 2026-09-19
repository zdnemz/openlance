import { chromium } from "playwright-core";
async function main() {
  const browser = await chromium.launch({
    executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("http://localhost:3000/projects/7c6b401d-fe17-444e-aa9d-99087807dede?persona=0", {
    waitUntil: "domcontentloaded", timeout: 90000,
  });
  await page.waitForTimeout(12000);
  const toasts = await page.evaluate(`
    (() => {
      const out = [];
      for (const t of document.querySelectorAll('[data-sonner-toast]')) {
        const r = t.getBoundingClientRect();
        out.push(t.textContent?.slice(0, 40) + ' @ ' + Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
      return out.join(' | ') || 'no toasts';
    })()
  `);
  console.log("TOASTS:", toasts);
  await browser.close();
}
void main();
