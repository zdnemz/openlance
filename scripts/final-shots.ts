import { chromium } from "playwright-core";
import { execSync } from "child_process";

function nextUp(): boolean {
  try {
    const code = execSync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ --max-time 30`, { timeout: 40000 }).toString().trim();
    return code === "200";
  } catch { return false; }
}
function revive(): void {
  try { execSync(`pkill -f "next dev"; pkill -f next-server; sleep 3; rm -rf .next; python3 scripts/daemonize-next.py`, { timeout: 30000 }); } catch { /* noop */ }
  for (let i = 0; i < 14; i++) {
    execSync("sleep 12");
    if (nextUp()) return;
    try { execSync(`pkill -f "next dev"; pkill -f next-server; sleep 3; rm -rf .next; python3 scripts/daemonize-next.py`, { timeout: 30000 }); } catch { /* noop */ }
  }
  throw new Error("could not revive next");
}

async function main() {
  const shots: [string, string, number, number][] = [
    ["landing-desktop", "http://localhost:3000/", 1440, 900],
    ["landing-mobile", "http://localhost:3000/", 390, 844],
    ["dashboard", "http://localhost:3000/dashboard?persona=0", 1440, 900],
    ["project-room", "http://localhost:3000/projects/7c6b401d-fe17-444e-aa9d-99087807dede?persona=0", 1440, 900],
    ["arbiters", "http://localhost:3000/arbiters?persona=0", 1440, 900],
    ["jobs", "http://localhost:3000/jobs?persona=0", 1440, 900],
  ];
  for (const [name, url, w, h] of shots) {
    if (!nextUp()) revive();
    // warm the route first via curl so the browser hits a compiled page
    try { execSync(`curl -s -o /dev/null --max-time 120 "${url}"`, { timeout: 130000 }); } catch { /* continue */ }
    if (!nextUp()) revive();
    const browser = await chromium.launch({
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
    });
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForTimeout(11000);
      await page.screenshot({ path: `download/v2-${name}.png`, fullPage: name.includes("landing") });
      console.log(`${name}: saved (${errors.length} page errors)`);
    } catch (e) {
      console.log(`${name}: FAILED ${String(e).slice(0, 80)}`);
    }
    await browser.close();
  }
}
void main();
