import playwright from "playwright";
import dayjs from "dayjs";

/**
 * API: GET /api/classes?start=YYYY-MM-DD&end=YYYY-MM-DD
 * Returns: { calendars: string[], events: [{ cal,title,start,end,url?,location?,color? }] }
 */
export default async function handler(req: any, res: any) {
  const WEBTRAC_DETAIL_BASE = process.env.WEBTRAC_DETAIL_BASE;
  const BASE_ORIGIN = process.env.BASE_ORIGIN || "";

  try {
    // 1) Validate inputs
    const start = String(req.query.start || "");
    const end   = String(req.query.end || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ error: "Provide start and end as YYYY-MM-DD" });
    }
    if (!WEBTRAC_DETAIL_BASE) {
      return res.status(500).json({ error: "WEBTRAC_DETAIL_BASE is not configured" });
    }

    // 2) Build Detail view URL with date range (WebTrac expects MM/DD/YYYY)
    const begin = dayjs(start).format("MM/DD/YYYY");
    const finish = dayjs(end).format("MM/DD/YYYY");
    const url = `${WEBTRAC_DETAIL_BASE}&BeginDate=${encodeURIComponent(begin)}&EndDate=${encodeURIComponent(finish)}`;

    // 3) Launch Chromium and load the page
    const browser = await playwright.chromium.launch({ headless: true });
    let events: any[] = [];
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

      // 4) Parse the first table with usable headers (Detail view)
      events = await page.evaluate((baseOrigin) => {
        function clean(s: string) { return (s || "").replace(/\s+/g, " ").trim(); }
        function absolutize(href: string) {
          if (!href) return null;
          if (/^https?:\/\//i.test(href)) return href;
          return baseOrigin ? `${baseOrigin}${href.startsWith("/") ? "" : "/"}${href}` : href;
        }
        function findHeaderIdx(headers: string[], keys: string[]) {
          const idx = headers.findIndex(h => keys.some(k => h.includes(k)));
          return idx;
        }
        function parseDateTime(dateText: string, timeText: string) {
          const dateMatch = dateText.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
          const times = (timeText || dateText).match(/(\d{1,2}:\d{2}\s*[AP]M)\s*[-–]\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
          if (!dateMatch || !times) return null;
          return { date: dateMatch[0], start: times[1], end: times[2] };
        }

        // Find candidate tables
        const tables = Array.from(document.querySelectorAll("table"));
        let target: HTMLTableElement | null = null;

        for (const el of tables) {
          const thCount = el.querySelectorAll("thead th").length;
          const trCount = el.querySelectorAll("tbody tr").length;
          if (thCount >= 3 && trCount >= 1) { target = el as HTMLTableElement; break; }
        }

        // Fallback: try single tbody table
        if (!target && tables.length) target = tables[0] as HTMLTableElement;
        if (!target) return [];

        const headers = Array.from(target.querySelectorAll("thead th"))
          .map(th => clean(th.textContent || "").toLowerCase());

        const idxDate = findHeaderIdx(headers, ["date"]);
        const idxTime = findHeaderIdx(headers, ["time", "hours", "start"]);
        const idxAct  = findHeaderIdx(headers, ["activity", "class", "title", "description", "program"]);
        const idxLoc  = findHeaderIdx(headers, ["location", "room", "facility"]);

        const rows = Array.from(target.querySelectorAll("tbody tr"));
        const out: any[] = [];

        for (const tr of rows) {
          const tds = Array.from(tr.querySelectorAll("td"));
          if (!tds.length) continue;

          const dateText = idxDate >= 0 ? clean(tds[idxDate].textContent || "") : "";
          const timeText = idxTime >= 0 ? clean(tds[idxTime].textContent || "") : "";
          const actCell  = idxAct >= 0 ? tds[idxAct] : tds[0];
          const title    = clean(actCell.textContent || "");
          const linkEl   = actCell.querySelector<HTMLAnchorElement>("a[href]");
          const href     = linkEl?.getAttribute("href") || "";
          const urlAbs   = absolutize(href);
          const loc      = idxLoc >= 0 ? clean(tds[idxLoc].textContent || "") : null;

          const dt = parseDateTime(dateText, timeText);
          if (!dt) continue;

          const startStr = `${dt.date} ${dt.start}`;
          const endStr   = `${dt.date} ${dt.end}`;

          // Use local timezone of the server; the client will render in its own TZ
          const startISO = new Date(startStr);
          const endISO   = new Date(endStr);
          if (isNaN(+startISO) || isNaN(+endISO)) continue;

          // crude calendar bucketing (refine if you want different tabs)
          const bucketText = `${title} ${loc || ""}`.toLowerCase();
          let cal = "Schedule";
          if (/\b(aqua|water|swim|pool)\b/.test(bucketText)) cal = "Aquatics";
          else if (/\b(pickleball|basketball|volleyball|court)\b/.test(bucketText)) cal = "Court Sports";
          else if (/\b(yoga|coffee|teen|community|wellness)\b/.test(bucketText)) cal = "Community";

          const color = cal === "Aquatics" ? "blue" :
                        cal === "Court Sports" ? "orange" :
                        cal === "Community" ? "pink" : "gray";

          out.push({
            cal,
            title,
            start: startISO.toISOString(),
            end: endISO.toISOString(),
            url: urlAbs,
            location: loc,
            color
          });
        }
        return out;
      }, BASE_ORIGIN);
    } finally {
      await browser.close();
    }

    // 5) Respond with calendars + events
    const calendars = Array.from(new Set(events.map((e: any) => e.cal))).sort();
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=300");
    return res.status(200).json({ calendars, events, source: "webtrac-detail-scrape" });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Scrape failed" });
  }
}