// /api/classes.js  (ESM because "type":"module")
import { request } from "undici";
import dayjs from "dayjs";
import * as cheerio from "cheerio";

/**
 * API: GET /api/classes?start=YYYY-MM-DD&end=YYYY-MM-DD[&debug=1]
 * Returns CALS object: { key: { label, events:[{id,name,dayIndex,startMinutes,endMinutes,url,color:{bg,text,border}}] } }
 */

const PALETTE = {
  blue:   ["bg-blue-100","text-blue-800","border-blue-500"],
  orange: ["bg-orange-100","text-orange-800","border-orange-500"],
  pink:   ["bg-pink-100","text-pink-800","border-pink-500"],
  gray:   ["bg-gray-200","text-gray-800","border-gray-500"]
};

export default async function handler(req, res) {
  try {
    const WEBTRAC_DETAIL_BASE = process.env.WEBTRAC_DETAIL_BASE;
    const BASE_ORIGIN = process.env.BASE_ORIGIN || "";

    const start = String(req.query.start || "");
    const end   = String(req.query.end || "");
    const debug = String(req.query.debug || "") === "1";

    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ error: "Provide start and end as YYYY-MM-DD" });
    }
    if (!WEBTRAC_DETAIL_BASE) {
      return res.status(500).json({ error: "WEBTRAC_DETAIL_BASE not configured" });
    }

    const beginMDY  = dayjs(start).format("MM/DD/YYYY");
    const finishMDY = dayjs(end).format("MM/DD/YYYY");
    const url = `${WEBTRAC_DETAIL_BASE}&BeginDate=${encodeURIComponent(beginMDY)}&EndDate=${encodeURIComponent(finishMDY)}`;

    const html = await fetchHtml(url);

    // Try the robust table parser; if nothing found, try a loose fallback.
    let { events: rawEvents, diag } = parseDetailHtml(html, BASE_ORIGIN);
    if (rawEvents.length === 0) {
      const fb = parseFallback(html, BASE_ORIGIN);
      rawEvents = fb.events;
      diag = { ...diag, fallbackUsed: true, fallbackCount: rawEvents.length };
    }

    // Build CALS for your front-end (skip any event missing required fields)
    const monday = getMonday(new Date(start));
    const CALS = {};
    for (const ev of rawEvents) {
      if (!ev || !ev.title || !ev.startISO || !ev.endISO || !ev.cal) continue;

      const s = new Date(ev.startISO);
      const e = new Date(ev.endISO);
      if (isNaN(+s) || isNaN(+e)) continue;

      const dayIndex = Math.floor((s.getTime() - monday.getTime()) / 86400000);
      if (dayIndex < 0 || dayIndex > 6) continue;

      const startMinutes = s.getHours() * 60 + s.getMinutes();
      const endMinutes   = e.getHours() * 60 + e.getMinutes();

      const colorKey = colorForCal(ev.cal);
      const [bg, text, border] = PALETTE[colorKey];
      const key = ev.cal.toLowerCase().replace(/\s+/g, "") || "schedule";

      if (!CALS[key]) CALS[key] = { label: ev.cal, events: [] };
      CALS[key].events.push({
        id: `${ev.title}-${ev.startISO}`,
        name: ev.title,
        dayIndex,
        startMinutes,
        endMinutes,
        url: ev.url || null,
        color: { bg, text, border }
      });
    }

    // Optional diagnostics to help when tuning selectors
    if (debug) {
      return res.status(200).json({ diag, sampleOutKeys: Object.keys(CALS), CALS });
    }

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=300");
    return res.status(200).json(CALS);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Scrape failed" });
  }
}

/* ---------------- helpers ---------------- */

async function fetchHtml(url) {
  const { body, statusCode } = await request(url, {
    method: "GET",
    headers: {
      "User-Agent": "gm-calendar-scraper/1.0",
      "Accept": "text/html,application/xhtml+xml"
    }
  });
  if (statusCode < 200 || statusCode >= 300) throw new Error(`Fetch failed: ${statusCode}`);
  return await body.text();
}

/**
 * Structured parser for Display=Detail tables.
 * - Finds first table with THEAD and TBODY.
 * - Matches headers to Date/Time/Activity/Location columns (keyword-based).
 * - Returns diagnostics describing what it found.
 */
function parseDetailHtml(html, baseOrigin) {
  const $ = cheerio.load(html);
  const diag = { foundTable: false, headers: [], idx: {} };

  let $table = null;
  $("table").each((_, el) => {
    const hasHead = $(el).find("thead th").length >= 3;
    const hasBody = $(el).find("tbody tr").length >= 1;
    if (hasHead && hasBody && !$table) $table = $(el);
  });
  if (!$table) return { events: [], diag: { ...diag, foundTable: false } };

  diag.foundTable = true;

  const headers = [];
  $table.find("thead th").each((_, th) => headers.push(clean($(th).text()).toLowerCase()));
  diag.headers = headers;

  const idxDate = findHeader(headers, ["date"]);
  const idxTime = findHeader(headers, ["time","hours","start"]);
  const idxAct  = findHeader(headers, ["activity","class","title","description","program","course"]);
  const idxLoc  = findHeader(headers, ["location","room","facility"]);
  diag.idx = { idxDate, idxTime, idxAct, idxLoc };

  const out = [];
  $table.find("tbody tr").each((_, tr) => {
    const $tds = $(tr).find("td");
    if (!$tds.length) return;

    const dateText = idxDate >= 0 ? clean($tds.eq(idxDate).text()) : "";
    const timeText = idxTime >= 0 ? clean($tds.eq(idxTime).text()) : "";
    const $actCell = idxAct >= 0 ? $tds.eq(idxAct) : $tds.eq(0);
    const titleRaw = clean($actCell.text());
    const title = titleRaw || clean($actCell.find("a").first().text());
    if (!title) return;

    const href = $actCell.find("a[href]").first().attr("href");
    const urlAbs = absolutize(href, baseOrigin);
    const loc = idxLoc >= 0 ? clean($tds.eq(idxLoc).text()) : null;

    const dt = parseDateTime(dateText, timeText) || parseDateTimeLoose($actCell.text());
    if (!dt) return;

    const startISO = toISO(`${dt.date} ${dt.start}`);
    const endISO   = toISO(`${dt.date} ${dt.end}`);
    if (!startISO || !endISO) return;

    const cal = guessCal(title, loc);

    out.push({ cal, title, startISO, endISO, url: urlAbs, location: loc });
  });

  return { events: out, diag };
}

/**
 * Very loose fallback if no thead/tbody table structure matches.
 * - Scans rows/blocks for date + time patterns anywhere in the text.
 */
function parseFallback(html, baseOrigin) {
  const $ = cheerio.load(html);
  const diag = { mode: "fallback" };
  const out = [];

  const blocks = $('tr, li, .row, .result, .item, [class*="result"], [class*="row"]');
  blocks.each((_, el) => {
    const $el = $(el);
    const text = clean($el.text());
    if (!/\d{1,2}\/\d{1,2}\/\d{4}/.test(text)) return;

    const dt = parseDateTimeLoose(text);
    if (!dt) return;

    let title = clean($el.find("a").first().text());
    if (!title) {
      // try first non-empty line
      title = (text.split("\n").map(s => clean(s)).find(s => s && !/\d{1,2}:\d{2}\s*[AP]M/i.test(s)) || "").slice(0, 160);
    }
    if (!title) return;

    const href = $el.find("a[href]").first().attr("href");
    const urlAbs = absolutize(href, baseOrigin);

    const startISO = toISO(`${dt.date} ${dt.start}`);
    const endISO   = toISO(`${dt.date} ${dt.end}`);
    if (!startISO || !endISO) return;

    const cal = guessCal(title, null);

    out.push({ cal, title, startISO, endISO, url: urlAbs, location: null });
  });

  return { events: out, diag };
}

/* ---------- small utils ---------- */
function clean(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function findHeader(headers, keys) { return headers.findIndex(h => keys.some(k => h.includes(k))); }
function absolutize(href, baseOrigin) {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  if (!baseOrigin) return href;
  return `${baseOrigin}${href.startsWith("/") ? "" : "/"}${href}`;
}
function parseDateTime(dateText, timeText) {
  const date = (dateText || "").match(/\d{1,2}\/\d{1,2}\/\d{4}/);
  const times = (timeText || dateText || "").match(/(\d{1,2}:\d{2}\s*[AP]M)\s*[-–—]\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
  if (!date || !times) return null;
  return { date: date[0], start: times[1].replace(/\s+/g, " "), end: times[2].replace(/\s+/g, " ") };
}
function parseDateTimeLoose(text) {
  const date = (text || "").match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/);
  const times = (text || "").match(/(\d{1,2}:\d{2}\s*[AP]M)\s*[-–—]\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
  if (!date || !times) return null;
  return { date: date[0], start: times[1].replace(/\s+/g, " "), end: times[2].replace(/\s+/g, " ") };
}
function toISO(s) { const d = new Date(s); return isNaN(+d) ? null : d.toISOString(); }
function guessCal(title, loc) {
  const t = `${title} ${loc || ""}`.toLowerCase();
  if (/\b(aqua|water|swim|pool)\b/.test(t)) return "Aquatics";
  if (/\b(pickleball|basketball|volleyball|court)\b/.test(t)) return "Court Sports";
  if (/\b(yoga|coffee|teen|community|wellness)\b/.test(t)) return "Community";
  return "Schedule";
}
function colorForCal(cal) {
  if (cal === "Aquatics") return "blue";
  if (cal === "Court Sports") return "orange";
  if (cal === "Community") return "pink";
  return "gray";
}
function getMonday(d) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // Mon=0
  x.setHours(0,0,0,0);
  x.setDate(x.getDate() - day);
  return x;
}