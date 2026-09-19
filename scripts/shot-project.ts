import { chromium } from "playwright-core";
async function main() {
  const browser = await chromium.launch({
    executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto("http://localhost:3000/projects/7c6b401d-fe17-444e-aa9d-99087807dede?persona=0", {
    waitUntil: "domcontentloaded", timeout: 90000,
  });
  await page.waitForTimeout(14000);
  await page.screenshot({ path: "tool-results/project-full.png", fullPage: true });
  // also list card-like elements with their ancestry text
  const info = await page.evaluate(`
    (() => {
      const out = [];
      const hasBox = (el) => {
        const s = window.getComputedStyle(el);
        const r = parseFloat(s.borderRadius) || 0;
        const bg = s.backgroundColor;
        const hasBg = bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "rgb(9, 9, 11)";
        const hasBorder = s.borderTopWidth !== "0px" && s.borderTopStyle !== "none";
        return r > 8 && (hasBg || hasBorder);
      };
      for (const el of document.querySelectorAll("div, details, section, aside")) {
        if (!hasBox(el)) continue;
        let p = el.parentElement;
        while (p && p !== document.body) {
          if (hasBox(p) && p.getBoundingClientRect().height > 60) {
            out.push("IN<" + String(el.className).slice(0,44) + "|h" + Math.round(el.getBoundingClientRect().height) + "> OUT<" + String(p.className).slice(0,34) + "|h" + Math.round(p.getBoundingClientRect().height) + ">");
            break;
          }
          p = p.parentElement;
        }
      }
      return [...new Set(out)].slice(0, 14).join("\\n") || "none";
    })()
  `);
  console.log(info);
  await browser.close();
}
void main();
