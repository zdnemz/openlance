import { chromium } from "playwright-core";
async function main() {
  const browser = await chromium.launch({
    executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  });
  const page = await browser.newPage();
  await page.goto("http://localhost:3000/projects/7c6b401d-fe17-444e-aa9d-99087807dede?persona=0", {
    waitUntil: "domcontentloaded", timeout: 90000,
  });
  await page.waitForTimeout(14000);
  const nested = await page.evaluate(`
    (() => {
      const out = [];
      const hasBox = (el) => {
        const s = window.getComputedStyle(el);
        const r = parseFloat(s.borderRadius);
        const hasBg = s.backgroundColor !== "rgba(0, 0, 0, 0)";
        const hasBorder = s.borderStyle !== "none" && parseFloat(s.borderWidth) > 0;
        return r > 8 && (hasBg && s.backgroundColor !== "rgba(9, 9, 11, 1)" || hasBorder);
      };
      for (const el of document.querySelectorAll("div, details, button")) {
        if (!hasBox(el)) continue;
        let p = el.parentElement;
        while (p && p !== document.body) {
          if (hasBox(p)) {
            out.push("NESTED <" + el.tagName + " " + String(el.className).slice(0, 55) + "> in <" + String(p.className).slice(0, 38) + ">");
            break;
          }
          p = p.parentElement;
        }
      }
      return [...new Set(out)].slice(0, 10).join("\\n") || "none";
    })()
  `);
  console.log(nested);
  await browser.close();
}
void main();
