/** Probe nested bordered+rounded boxes in the project room. */
import { chromium } from "playwright-core";

async function main() {
  const browser = await chromium.launch({
    executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  });
  const page = await browser.newPage();
  await page.goto("http://localhost:3000/projects/7c6b401d-fe17-444e-aa9d-99087807dede?persona=0", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForTimeout(6000);
  const nested = await page.evaluate(() => {
    const out: string[] = [];
    const hasBox = (el: Element) => {
      const s = window.getComputedStyle(el as HTMLElement);
      return s.borderStyle !== "none" && parseFloat(s.borderWidth) > 0 && parseFloat(s.borderRadius) > 6;
    };
    for (const el of document.querySelectorAll("div, details")) {
      if (!hasBox(el)) continue;
      let p = el.parentElement;
      while (p && p !== document.body) {
        if (hasBox(p)) {
          out.push(
            `NESTED: <${el.tagName} class="${(el.className || "").toString().slice(0, 60)}"> inside <${(p.className || "").toString().slice(0, 44)}>`,
          );
          break;
        }
        p = p.parentElement;
      }
    }
    return [...new Set(out)].slice(0, 12);
  });
  console.log(nested.join("\n") || "none");
  await browser.close();
}
void main();
