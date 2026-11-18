// A real GPT Realtime call against the running app (pnpm dev), with a synthesized caller: each line of
// e2e/lines.json is played into a fake microphone once the voice is listening again, and the plan is
// checked after each one. The run is screen-recorded with the model's own voice, then encoded.
// Needs OPENAI_API_KEY in .env.local and `pnpm e2e:voice` first. Usage: node e2e/live-call.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BASE = process.env.BASE ?? "http://localhost:3300";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ALL_LINES = JSON.parse(fs.readFileSync(path.join(ROOT, "e2e/lines.json"), "utf8"));
// LINES=1 runs only the first line, for debugging.
const LINES = ALL_LINES.slice(0, Number(process.env.LINES ?? ALL_LINES.length));
const VOICE = LINES.map((_, i) => fs.readFileSync(path.join(ROOT, `e2e/voice/line-${i + 1}.wav`)).toString("base64"));
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const TAKE = path.join(ROOT, "e2e/takes", STAMP);
const FRAMES = path.join(TAKE, "frames");
fs.mkdirSync(FRAMES, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${m}`);

/* ───────────────────────── the checks (the design's demo script) ───────────────────────── */

const allStops = (trip) => trip.days.flatMap((day) => day.stops.map((stop) => ({ ...stop, day })));
const isFriday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 5;
const today = new Date().toLocaleDateString("en-CA");

const CASTLE = /castle|castelo|s[ãa]o jorge/i;
const DAY_TRIP = /sintra|cascais|[óo]bidos|[ée]vora|f[áa]tima|nazar[ée]|set[úu]bal|arr[áa]bida|mafra|ericeira|coimbra|tomar|day trip/i;
/** The fado dinner, not a fado museum: a fado stop that is food or in the evening. */
const fadoDinner = (trip) => allStops(trip).find((s) => /fado/i.test(s.title) && (s.kind === "food" || (s.time ?? "") >= "17:00"));
const beforeNoonSat = (s) => s && s.day.weekday === "Sat" && !!s.time && s.time < "12:00";

/** Each returns null when the plan is right, or why it isn't. `before` is the plan when the line started. */
const CHECKS = [
  (trip) => {
    if (trip.days.length !== 3) return `expected 3 days, got ${trip.days.length}`;
    const weekdays = trip.days.map((d) => d.weekday).join(",");
    if (weekdays !== "Fri,Sat,Sun") return `expected Fri,Sat,Sun, got ${weekdays}`;
    if (trip.days.some((d) => d.stops.length === 0)) return "a day has no stops";
    const castle = allStops(trip).find((s) => CASTLE.test(s.title));
    if (!castle || !fadoDinner(trip)) return `the model's first plan had no ${!castle ? "castle" : "fado dinner"}`;
    const dayTrip = trip.days.some((d) => DAY_TRIP.test([d.area, ...d.stops.flatMap((s) => [s.title, s.area])].join(" ")));
    if (!dayTrip) return "no day is a day trip out of the city";
    return null;
  },
  (trip, _dom, before) => {
    // The end state is what was asked for: a castle (São Jorge, or a Sintra one: the line only says
    // "the castle") on Saturday morning. The first plan may already have it on Saturday.
    if (!allStops(trip).some((s) => CASTLE.test(s.title) && beforeNoonSat(s))) return "no castle is on Saturday morning";
    const old = fadoDinner(before);
    if (!old) return "there was no fado dinner to swap";
    const cheaper = (s) => old.estimate === undefined || (s.estimate ?? Infinity) < old.estimate;
    const now = allStops(trip).find((s) => s.id === old.id);
    // Swapped in place: same stop, new title, lower estimate ("something cheaper" may still mention fado).
    if (now) return now.title === old.title ? "the fado dinner is still there" : cheaper(now) ? null : "the swapped dinner isn't cheaper";
    const beforeIds = new Set(allStops(before).map((s) => s.id));
    const replacement = allStops(trip).find(
      (s) => !beforeIds.has(s.id) && s.day.id === old.day.id && (s.time ?? "") >= "17:00" && !/fado/i.test(s.title),
    );
    if (!replacement) return "the fado dinner was removed but nothing replaced it";
    return cheaper(replacement) ? null : "the new dinner isn't cheaper";
  },
  (_trip, dom) => (dom.readyPanels > 0 && dom.stoppedPanels === 0 ? null : "no panel is ready yet"),
  (trip) => {
    if (trip.view !== "calendar") return `the view is ${trip.view}`;
    const start = trip.startDate;
    if (!start) return "no start date";
    if (!start.endsWith("-11") || !isFriday(start)) return `the start date ${start} is not a Friday the 11th`;
    if (start < today) return `the start date ${start} is in the past`;
    return null;
  },
  (trip, _dom, before) => (trip.revision === before.revision ? null : "the plan changed after 'Perfect, thanks.'"),
];
const TIMEOUT_MS = [45_000, 45_000, 75_000, 45_000, 6_000];

/* ───────────────────────── browser ───────────────────────── */

// The first request after `pnpm dev` compiles the routes; don't let that eat the call's timeouts.
for (const p of ["/", "/api/copilotkit/info"]) await fetch(BASE + p).catch(() => {});

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--window-size=1440,987",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--force-device-scale-factor=2",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
  ],
  defaultViewport: null,
});
const page = (await browser.pages())[0] ?? (await browser.newPage());
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
page.on("pageerror", (e) => log(`pageerror ${e.message.slice(0, 200)}`));
page.on("console", (m) => m.type() === "error" && log(`console ${m.text().slice(0, 200)}`));
await page.evaluateOnNewDocument(fs.readFileSync(path.join(ROOT, "e2e/fake-mic.js"), "utf8"));
await page.goto(BASE, { waitUntil: "networkidle2", timeout: 120_000 });
await page.waitForSelector('[data-action="call"]');

// A visible cursor for the clicks (headless has none).
await page.evaluate(() => {
  const c = document.createElement("div");
  c.id = "rec-cursor";
  c.innerHTML =
    '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2.5 L4 19 L8.6 14.9 L11.6 21.5 L14.4 20.3 L11.5 13.8 L17.6 13.8 Z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none", opacity: "0", transition: "opacity 180ms ease" });
  document.documentElement.appendChild(c);
  document.addEventListener("mousemove", (e) => (c.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`), true);
});
let pos = { x: 1040, y: 640 };
async function glideAndClick(selector) {
  const box = await (await page.$(selector)).boundingBox();
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate(() => (document.getElementById("rec-cursor").style.opacity = "1"));
  const from = { ...pos };
  const start = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - start) / 800);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    if (t >= 1) break;
    await wait(8);
  }
  pos = to;
  await wait(160);
  await page.mouse.down();
  await wait(70);
  await page.mouse.up();
  await wait(250);
  await page.evaluate(() => (document.getElementById("rec-cursor").style.opacity = "0"));
}

const state = () =>
  page.evaluate(() => ({
    status: window.__callYourUi?.getStatus(),
    trip: window.__callYourUi?.getTrip(),
    dom: {
      readyPanels: document.querySelectorAll('[data-panel-status="ready"]').length,
      stoppedPanels: document.querySelectorAll('[data-panel-status="stopped"], [data-panel-status="error"]').length,
    },
    error: document.querySelector(".pill-error, .pill-warn")?.textContent ?? null,
  }));

/** Waits until the call has been in `status` for `holdMs` in a row. */
async function waitForStatus(status, holdMs, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let since = null;
  while (Date.now() < end) {
    const s = await state();
    if (s.status === "error") throw new Error(`the call failed: ${s.error}`);
    if (s.status === status) {
      since ??= Date.now();
      if (Date.now() - since >= holdMs) return;
    } else since = null;
    await wait(100);
  }
  throw new Error(`the call was not "${status}" within ${timeoutMs / 1000}s`);
}

/* ───────────────────────── recording ───────────────────────── */

const frames = [];
let writing = Promise.resolve();
const cdp = await page.createCDPSession();
cdp.on("Page.screencastFrame", (e) => {
  cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
  const file = `${String(frames.length).padStart(5, "0")}.jpg`;
  frames.push({ file, ts: e.metadata.timestamp });
  const buf = Buffer.from(e.data, "base64");
  writing = writing.then(() => fs.promises.writeFile(path.join(FRAMES, file), buf));
});

const played = [];
const results = [];
/** Errors the pill showed without ending the call. */
const pillErrors = new Set();
let failed = null;
try {
  await page.mouse.move(pos.x, pos.y);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88 });
  await wait(1200);

  await glideAndClick('[data-action="call"]');
  log("pressed Call");
  await waitForStatus("listening", 600, 30_000);
  log("connected");

  for (const [i, text] of LINES.entries()) {
    await waitForStatus("listening", 800, 60_000);
    const before = await state();
    log(`caller: "${text}"`);
    const line = await page.evaluate((b64) => window.__fakeMic.say(b64), VOICE[i]);
    played.push({ index: i, ...line });

    const end = Date.now() + TIMEOUT_MS[i];
    let why = "not checked";
    let settledSince = null;
    for (;;) {
      const s = await state();
      if (s.status === "error") throw new Error(`the call failed: ${s.error}`);
      if (s.error) pillErrors.add(s.error);
      why = CHECKS[i](s.trip, s.dom, before.trip);
      // Line 5 must hold for the whole window; the others pass as soon as the plan is right.
      if (i !== 4 && !why) break;
      // The model finished its turn (changed the plan, back to listening) and the plan is still wrong.
      if (i !== 4 && s.trip.revision !== before.trip.revision && s.status === "listening") {
        settledSince ??= Date.now();
        if (Date.now() - settledSince > 2_500) break;
      } else settledSince = null;
      if (Date.now() > end) break;
      await wait(250);
    }
    results.push({ line: i + 1, text, ok: !why, why, ms: Date.now() - line.endedAt });
    if (why) throw new Error(`line ${i + 1}: ${why}`);
    log(`  ok (${((Date.now() - line.endedAt) / 1000).toFixed(1)}s after the line)`);
  }

  await waitForStatus("listening", 600, 30_000);
  await wait(800);
  await glideAndClick('[data-action="hangup"]');
  await waitForStatus("idle", 0, 5_000);
  log("hung up");
  await wait(1500);
} catch (error) {
  failed = error;
  log(`FAIL ${error.message}`);
} finally {
  await cdp.send("Page.stopScreencast").catch(() => {});
  await writing;
  const remote = await page.evaluate(() => window.__remoteAudio.stop()).catch(() => null);
  if (remote) {
    fs.writeFileSync(path.join(TAKE, "remote.webm"), Buffer.from(remote.base64, "base64"));
    fs.writeFileSync(path.join(TAKE, "remote.json"), JSON.stringify({ startedAt: remote.startedAt }));
  }
  fs.writeFileSync(path.join(TAKE, "frames.json"), JSON.stringify({ frames }));
  fs.writeFileSync(path.join(TAKE, "lines.json"), JSON.stringify(played, null, 2));
  const final = await state().catch(() => null);
  const events = await page.evaluate(() => window.__events ?? []).catch(() => []);
  fs.writeFileSync(path.join(TAKE, "events.json"), JSON.stringify(events.map((e) => ({ ...e, t: e.t - t0 })), null, 2));
  fs.writeFileSync(path.join(TAKE, "result.json"), JSON.stringify({ ok: !failed, results, error: failed?.message ?? null, pillErrors: [...pillErrors], trip: final?.trip }, null, 2));
  await browser.close();
}

log(`frames ${frames.length} → ${path.relative(ROOT, TAKE)}`);
if (frames.length && played.length) {
  try {
    execFileSync("python3", [path.join(ROOT, "e2e/encode.py"), TAKE], { stdio: "inherit" });
  } catch (e) {
    log(`encode failed: ${e.message}`);
  }
}
if (failed) process.exit(1);
log("PASS");
