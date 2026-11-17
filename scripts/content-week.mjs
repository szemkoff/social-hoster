#!/usr/bin/env node
/**
 * content-week — stack a week of posts across connected channels, with daily
 * Instagram Trial Reels, through the Social Hoster API.
 *
 * Env:
 *   SOCIAL_HOSTER_URL      Base URL of your deployment, e.g. https://social.example.com
 *   SOCIAL_HOSTER_API_KEY  Read & Write App Access key (sk_...), from Settings -> API keys
 *
 * Commands:
 *   channels                         List connected channels (id, type, name, handle)
 *   template --start YYYY-MM-DD      Print a 7-day CSV plan with a daily Trial Reel slot
 *            [--time 09:00] [--reel-time 18:00] [--platforms instagram,facebook,linkedin]
 *   validate <plan.csv|plan.json>    Check a plan offline and print what would be queued
 *   push <plan> [--draft] [--dry-run] [--force]
 *                                    Create scheduled posts (or drafts with --draft).
 *                                    Writes <plan>.ledger.json so re-runs skip rows already pushed.
 *   queue [--days 7]                 Show what is scheduled for the next N days
 *
 * Plan columns (CSV) / fields (JSON "posts" array):
 *   date        YYYY-MM-DD (local to --tz / plan timezone, default America/New_York)
 *   time        HH:MM 24h
 *   platforms   Comma/pipe/semicolon list of channel types, names, or ids. "all" = every enabled channel.
 *   caption     Main post copy
 *   media       Public media URL(s), separated by | (video for reels)
 *   type        text | image | video  (inferred from media if blank)
 *   trial_reel  blank | manual | auto  -> Instagram Trial Reel (auto = SS_PERFORMANCE graduation)
 *   title       Optional internal title
 *   first_comment  Optional first comment (Instagram/Facebook/LinkedIn where supported)
 *   x_caption, linkedin_caption, instagram_caption, facebook_caption, threads_caption, tiktok_caption
 *               Optional per-platform caption overrides
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TZ = process.env.SOCIAL_HOSTER_TZ || "America/New_York";
const VIDEO_EXT = /\.(mp4|mov|m4v|webm)(\?|#|$)/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp)(\?|#|$)/i;
const CAPTION_OVERRIDE_TYPES = ["x", "twitter", "linkedin", "linkedin_company", "instagram", "instagram_personal", "facebook", "threads", "tiktok", "youtube", "bluesky", "pinterest"];

// ── CLI ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const command = argv[0];
const flags = parseFlags(argv.slice(1));

main().catch((error) => {
  console.error(`\nError: ${error.message}`);
  process.exit(1);
});

async function main() {
  switch (command) {
    case "channels":
      return cmdChannels();
    case "template":
      return cmdTemplate();
    case "validate":
      return cmdValidate();
    case "push":
      return cmdPush();
    case "queue":
      return cmdQueue();
    default:
      console.log(fs.readFileSync(new URL(import.meta.url)).toString().split("*/")[0]);
      process.exit(command ? 1 : 0);
  }
}

async function cmdChannels() {
  const channels = await fetchChannels();
  if (channels.length === 0) {
    console.log("No channels connected. Connect accounts in Dashboard -> Channels first.");
    return;
  }
  console.table(
    channels.map((c) => ({ id: c.id, type: c.type, name: c.name, handle: c.handle ?? "", provider: c.provider, enabled: c.enabled }))
  );
}

function cmdTemplate() {
  const start = flags.start || nextMonday();
  assertDate(start, "--start");
  const time = flags.time || "09:00";
  const reelTime = flags["reel-time"] || "18:00";
  const platforms = flags.platforms || "instagram,facebook,linkedin,x";
  const header = ["date", "time", "platforms", "type", "trial_reel", "title", "caption", "media", "first_comment", "x_caption"];
  const rows = [header.join(",")];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const day = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    rows.push(csvRow([date, time, platforms, "image", "", `${day} feed post`, `${day} caption goes here`, "https://YOUR-CDN/image-" + (i + 1) + ".jpg", "", ""]));
    rows.push(csvRow([date, reelTime, "instagram", "video", "auto", `${day} trial reel`, `${day} trial reel caption`, "https://YOUR-CDN/reel-" + (i + 1) + ".mp4", "", ""]));
  }
  const output = rows.join("\n") + "\n";
  if (flags.out) {
    fs.writeFileSync(flags.out, output);
    console.log(`Wrote ${flags.out} (${rows.length - 1} rows, week of ${start}).`);
  } else {
    process.stdout.write(output);
  }
}

async function cmdValidate() {
  const file = requirePlanPath();
  const plan = loadPlan(file);
  const channels = flags.offline ? null : await fetchChannels().catch(() => null);
  const { items, problems } = buildPayloads(plan, channels);
  printPlan(items);
  report(problems);
  if (problems.some((p) => p.level === "error")) process.exit(1);
}

async function cmdPush() {
  const file = requirePlanPath();
  const plan = loadPlan(file);
  const channels = await fetchChannels();
  const { items, problems } = buildPayloads(plan, channels);
  report(problems);
  if (problems.some((p) => p.level === "error")) {
    throw new Error("Fix the errors above before pushing. Nothing was queued.");
  }

  const intent = flags.draft ? "draft" : "schedule";
  const ledgerPath = `${file}.ledger.json`;
  const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : {};
  const now = Date.now();
  let created = 0;
  let skipped = 0;

  for (const item of items) {
    if (ledger[item.key] && !flags.force) {
      console.log(`skip  ${item.label}  (already pushed as ${ledger[item.key].id})`);
      skipped++;
      continue;
    }
    if (intent === "schedule" && new Date(item.payload.scheduledAt).getTime() <= now + 60_000) {
      console.log(`skip  ${item.label}  (time is in the past)`);
      skipped++;
      continue;
    }
    const payload = { ...item.payload, intent };
    if (flags["dry-run"]) {
      console.log(`dry   ${item.label}\n${JSON.stringify(payload, null, 2)}`);
      continue;
    }
    const res = await api("POST", "/api/posts", payload);
    ledger[item.key] = { id: res.id, scheduledAt: payload.scheduledAt, pushedAt: new Date().toISOString() };
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    console.log(`${intent === "schedule" ? "sched" : "draft"} ${item.label}  -> ${res.id}`);
    created++;
  }

  console.log(`\nDone. ${created} created, ${skipped} skipped${flags["dry-run"] ? " (dry run)" : ""}.`);
  if (created && intent === "schedule") {
    console.log("Scheduled posts publish automatically within ~1 minute of their time (due-post worker).");
  }
}

async function cmdQueue() {
  const days = Number(flags.days || 7);
  const from = new Date();
  const to = new Date(from.getTime() + days * 86_400_000);
  const [{ posts }, channels] = await Promise.all([
    api("GET", `/api/posts?status=scheduled&from=${from.toISOString()}&to=${to.toISOString()}&limit=200`),
    fetchChannels(),
  ]);
  const byId = new Map(channels.map((c) => [c.id, c]));
  if (!posts.length) {
    console.log(`Nothing scheduled in the next ${days} days.`);
    return;
  }
  console.table(
    posts.map((p) => {
      const overrides = p.platformOverrides || {};
      const trial = Object.values(overrides).some((o) => o && o.trialReel);
      return {
        when: formatLocal(p.scheduledAt, flags.tz || DEFAULT_TZ),
        title: (p.title || p.content || "").slice(0, 40),
        channels: p.targets.map((t) => byId.get(t.platformId)?.type ?? t.platformId).join(", "),
        trialReel: trial ? "yes" : "",
        id: p.id,
      };
    })
  );
}

// ── Plan building ──────────────────────────────────────────────────────
function loadPlan(file) {
  const raw = fs.readFileSync(file, "utf8");
  if (file.endsWith(".json")) {
    const parsed = JSON.parse(raw);
    return { timezone: parsed.timezone, rows: parsed.posts || [] };
  }
  return { timezone: undefined, rows: parseCsv(raw) };
}

function buildPayloads(plan, channels) {
  const tz = flags.tz || plan.timezone || DEFAULT_TZ;
  const problems = [];
  const items = [];

  plan.rows.forEach((row, index) => {
    const line = `row ${index + 1}`;
    const get = (k) => (row[k] ?? row[camel(k)] ?? "").toString().trim();
    const date = get("date");
    const time = get("time") || "09:00";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return problems.push({ level: "error", msg: `${line}: date must be YYYY-MM-DD (got "${date}")` });
    if (!/^\d{1,2}:\d{2}$/.test(time)) return problems.push({ level: "error", msg: `${line}: time must be HH:MM (got "${time}")` });

    const caption = get("caption") || get("content");
    const media = splitList(row.media ?? row.mediaUrls ?? "", /[|\n]/);
    if (!caption && media.length === 0) return problems.push({ level: "error", msg: `${line}: needs a caption or media` });

    const trialReel = normalizeTrial(get("trial_reel"));
    const type = (get("type") || (media.some((m) => VIDEO_EXT.test(m)) ? "video" : media.length ? "image" : "text")).toLowerCase();

    const selectors = splitList(row.platforms ?? "", /[,;|]/);
    if (trialReel && !selectors.some((s) => s.toLowerCase().startsWith("instagram"))) selectors.push("instagram");
    if (selectors.length === 0) return problems.push({ level: "error", msg: `${line}: no platforms listed` });

    let targets = [];
    if (channels) {
      const enabled = channels.filter((c) => c.enabled);
      for (const sel of selectors) {
        const s = sel.toLowerCase();
        const matched = s === "all" ? enabled : enabled.filter((c) => c.id === sel || c.type.toLowerCase() === normalizeType(s) || c.name.toLowerCase() === s || (c.handle || "").toLowerCase().replace(/^@/, "") === s.replace(/^@/, ""));
        if (matched.length === 0) problems.push({ level: "error", msg: `${line}: no enabled channel matches "${sel}". Run "channels" to see what's connected.` });
        targets.push(...matched);
      }
      targets = [...new Map(targets.map((t) => [t.id, t])).values()];
    }

    const overrides = {};
    for (const t of CAPTION_OVERRIDE_TYPES) {
      const value = get(`${t}_caption`);
      if (value) overrides[normalizeType(t)] = { ...(overrides[normalizeType(t)] || {}), caption: value };
    }
    const firstComment = get("first_comment");
    if (firstComment) {
      for (const t of ["instagram", "instagram_personal", "facebook", "linkedin", "linkedin_company"]) {
        overrides[t] = { ...(overrides[t] || {}), firstComment };
      }
    }
    if (row.overrides && typeof row.overrides === "object") {
      for (const [k, v] of Object.entries(row.overrides)) overrides[k] = { ...(overrides[k] || {}), ...v };
    }

    if (trialReel) {
      if (!media.some((m) => VIDEO_EXT.test(m)) && type !== "video") {
        problems.push({ level: "error", msg: `${line}: trial reels need a public video URL (.mp4/.mov) in media` });
      }
      for (const t of ["instagram", "instagram_personal"]) {
        overrides[t] = { ...(overrides[t] || {}), format: "reel", trialReel };
      }
      const nonIgReel = targets.filter((c) => !c.type.startsWith("instagram"));
      if (nonIgReel.length) {
        problems.push({ level: "warn", msg: `${line}: Trial Reel flag only applies to Instagram; ${nonIgReel.map((c) => c.type).join(", ")} get a normal post` });
      }
    }

    for (const m of media) {
      if (!/^https:\/\//i.test(m)) problems.push({ level: "error", msg: `${line}: media must be a public https URL (${m})` });
      else if (m.includes("YOUR-CDN")) problems.push({ level: "error", msg: `${line}: replace the placeholder media URL ${m}` });
      else if (!VIDEO_EXT.test(m) && !IMAGE_EXT.test(m)) problems.push({ level: "warn", msg: `${line}: can't tell media type from URL ${m}` });
    }
    if (type === "text" && targets.some((c) => c.type.startsWith("instagram") || c.type === "tiktok")) {
      problems.push({ level: "error", msg: `${line}: Instagram/TikTok need media; add an image or video URL` });
    }

    const scheduledAt = zonedToUtc(date, time, tz).toISOString();
    const key = `${date}T${time}|${get("title") || caption.slice(0, 40)}|${selectors.join(",")}`;
    items.push({
      key,
      label: `${date} ${time} ${tz} ${trialReel ? "[TRIAL REEL] " : ""}${(get("title") || caption).slice(0, 50)} -> ${channels ? targets.map((t) => t.type).join(", ") : selectors.join(", ")}`,
      payload: {
        title: get("title") || undefined,
        content: caption,
        contentType: type,
        scheduledAt,
        ...(channels ? { platformIds: targets.map((t) => t.id) } : {}),
        ...(media.length ? { mediaUrls: media } : {}),
        ...(Object.keys(overrides).length ? { platformOverrides: overrides } : {}),
      },
    });
  });

  // Per-day sanity: remind if a day has no trial reel.
  const days = new Set(items.map((i) => i.key.slice(0, 10)));
  const trialDays = new Set(items.filter((i) => i.label.includes("[TRIAL REEL]")).map((i) => i.key.slice(0, 10)));
  if (trialDays.size && trialDays.size < days.size) {
    problems.push({ level: "warn", msg: `Trial Reels on ${trialDays.size} of ${days.size} days` });
  }
  return { items, problems };
}

function printPlan(items) {
  console.log(`\n${items.length} post(s):`);
  for (const item of items) console.log(`  ${item.label}`);
  console.log("");
}

function report(problems) {
  for (const p of problems) console.log(`${p.level === "error" ? "ERROR" : "warn "} ${p.msg}`);
}

// ── API ────────────────────────────────────────────────────────────────
async function fetchChannels() {
  const { platforms } = await api("GET", "/api/platforms");
  return platforms;
}

async function api(method, route, body) {
  const base = (process.env.SOCIAL_HOSTER_URL || "").replace(/\/$/, "");
  const key = process.env.SOCIAL_HOSTER_API_KEY;
  if (!base || !key) throw new Error("Set SOCIAL_HOSTER_URL and SOCIAL_HOSTER_API_KEY first.");
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${json.error || text.slice(0, 200)}`);
  return json;
}

// ── Helpers ────────────────────────────────────────────────────────────
function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) { out[name] = next; i++; } else out[name] = true;
    } else out._.push(a);
  }
  return out;
}

function requirePlanPath() {
  const file = flags._[0];
  if (!file || !fs.existsSync(file)) throw new Error("Pass a plan file: content-week <command> plan.csv");
  return path.resolve(file);
}

function normalizeTrial(v) {
  const s = (v || "").toLowerCase();
  if (!s || s === "no" || s === "false" || s === "0") return undefined;
  if (s === "auto" || s === "ss_performance" || s === "performance") return "SS_PERFORMANCE";
  return "MANUAL";
}

function normalizeType(t) {
  return t === "twitter" ? "x" : t;
}

function splitList(value, sep) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  return String(value).split(sep).map((s) => s.trim()).filter(Boolean);
}

function camel(k) {
  return k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Converts a wall-clock date/time in an IANA zone to a UTC Date (DST-safe). */
function zonedToUtc(date, time, tz) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        .formatToParts(new Date(guess))
        .map((p) => [p.type, p.value])
    );
    const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    const diff = Date.UTC(y, mo - 1, d, h, mi) - asLocal;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

function formatLocal(iso, tz) {
  return new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function nextMonday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function assertDate(v, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${name} must be YYYY-MM-DD`);
}

function csvRow(values) {
  return values.map((v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",");
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim())) rows.push(row);
  const [header, ...data] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return data.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""])));
}
