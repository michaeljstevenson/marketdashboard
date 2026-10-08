#!/usr/bin/env node
// Applies the text edits Edit Mode logged in preview-edits.json to the real
// page files, then commits and pushes them, so a session of edits in the
// local preview can go live without anyone else in the loop.
//
//   npm run publish-edits              apply, commit and push
//   npm run publish-edits -- --dry-run show what would change, touch nothing
//
// Edit Mode records each edited element's plain text before and after (no
// HTML), so an element is found by its original text. To stay safe it only
// replaces an element when exactly one element in the file has that text and
// that element holds plain text (no links or bold inside, which plain text
// would wipe out). Anything else is reported and left in preview-edits.json
// for a manual fix, never guessed at. Only the pages it changed are
// committed, so other work in progress stays out of the commit.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EDITS_FILE = path.join(ROOT, "preview-edits.json");
const DRY = process.argv.includes("--dry-run");
const TAGS = "p|div|span|h1|h2|h3|h4|h5|h6|li|td|th|summary|label|button|a|em|strong";

const decode = (s) => s
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;|&rsquo;/g, (m) => (m === "&#39;" ? "'" : "’")).replace(/&lsquo;/g, "‘")
  .replace(/&ldquo;/g, "“").replace(/&rdquo;/g, "”").replace(/&middot;/g, "·").replace(/&hellip;/g, "…")
  .replace(/&rho;/g, "ρ").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&");
const encode = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const norm = (s) => s.replace(/[\s ]+/g, " ").trim();
const sh = (cmd) => execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

if (!fs.existsSync(EDITS_FILE)) {
  console.log("No preview-edits.json, nothing to publish.");
  process.exit(0);
}
const edits = JSON.parse(fs.readFileSync(EDITS_FILE, "utf8"));
if (!edits.length) { console.log("preview-edits.json is empty."); process.exit(0); }

// Chains of edits to the same element collapse to: its original text, its
// final text.
const chains = new Map();
for (const e of [...edits].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))) {
  const key = e.page + "\u0000" + e.selector;
  if (!chains.has(key)) chains.set(key, { page: e.page, selector: e.selector, oldText: e.oldText, newText: e.newText, entries: [e] });
  else { const c = chains.get(key); c.newText = e.newText; c.entries.push(e); }
}

const changedFiles = new Set();
const leftover = [];
const pageCache = new Map();
for (const c of chains.values()) {
  const rel = c.page === "/" ? "index.html" : decodeURIComponent(c.page.replace(/^\//, ""));
  const file = path.join(ROOT, rel);
  const label = `${rel}: "${norm(c.oldText).slice(0, 60)}"`;
  if (norm(c.oldText) === norm(c.newText)) { console.log(`= no net change, ${label}`); continue; }
  if (!fs.existsSync(file)) { console.log(`! page not found, ${label}`); leftover.push(...c.entries); continue; }
  let html = pageCache.get(file) || fs.readFileSync(file, "utf8");
  const re = new RegExp(`(<(${TAGS})\\b[^>]*>)([^<]*)(</\\2>)`, "g");
  const hits = [];
  let m;
  while ((m = re.exec(html))) if (norm(decode(m[3])) === norm(c.oldText)) hits.push({ index: m.index, open: m[1], inner: m[3], close: m[4] });
  if (hits.length !== 1) {
    const inlineHit = new RegExp(`<(${TAGS})\\b[^>]*>(?:(?!</?(?:p|div|h[1-6]|li|td|th)\\b).)*?</\\1>`, "gs");
    const inline = [...html.matchAll(inlineHit)].some((x) => norm(decode(x[0].replace(/<[^>]+>/g, ""))) === norm(c.oldText));
    const why = hits.length > 1 ? `found ${hits.length} times, can't tell which one`
      : inline ? "the text has links or formatting inside, edit the file directly"
      : "not in the page's HTML (probably filled in by the page's script from data)";
    console.log(`! skipped, ${why}: ${label}`);
    leftover.push(...c.entries);
    continue;
  }
  const h = hits[0];
  const lead = h.inner.match(/^\s*/)[0], trail = h.inner.match(/\s*$/)[0];
  const replacement = h.open + lead + encode(c.newText.trim()) + trail + h.close;
  html = html.slice(0, h.index) + replacement + html.slice(h.index + h.open.length + h.inner.length + h.close.length);
  pageCache.set(file, html);
  changedFiles.add(rel);
  console.log(`✓ ${label}\n    → "${norm(c.newText).slice(0, 80)}"`);
}

if (!changedFiles.size) {
  console.log("\nNothing applied. preview-edits.json left as it was.");
  process.exit(leftover.length ? 1 : 0);
}
if (DRY) { console.log(`\nDry run: would update ${[...changedFiles].join(", ")}. Nothing changed.`); process.exit(0); }

for (const [file, html] of pageCache) fs.writeFileSync(file, html);
if (leftover.length) fs.writeFileSync(EDITS_FILE, JSON.stringify(leftover, null, 2));
else fs.unlinkSync(EDITS_FILE);

const files = [...changedFiles];
try {
  if (sh("git rev-parse --abbrev-ref HEAD") !== "main") throw new Error("not on the main branch");
  sh(`git add -- ${files.map((f) => JSON.stringify(f)).join(" ")}`);
  const msg = `Text edits from Edit Mode: ${files.join(", ")}`;
  execSync(`git commit -q -F -`, { cwd: ROOT, input: msg });
  sh("git pull -q --rebase --autostash origin main");
  sh("git push -q origin main");
  console.log(`\nPushed ${sh("git rev-parse --short HEAD")}: ${files.join(", ")}. Netlify publishes it in a minute or two.`);
} catch (err) {
  console.log(`\nThe pages were updated on disk but publishing failed: ${err.message.split("\n")[0]}`);
  console.log("Run `git status` to see where it stopped, or ask Claude.");
  process.exit(1);
}
if (leftover.length) console.log(`${leftover.length} edit(s) couldn't be applied and are still in preview-edits.json (see the ! lines above).`);
