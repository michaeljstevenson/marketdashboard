// Per-user curation of the "recently ended" streak feed, backed by a Netlify
// Blob. Same password gate as oddstats.js.
//
//   GET  /api/oddstats-curation                 -> { archived: [...], dismissed: [...] }
//   POST /api/oddstats-curation  { op, key, entry }
//        op = archive   (needs entry) — save an ended streak
//        op = unarchive (needs key)   — remove one from the archive
//        op = dismiss   (needs key)   — hide an ended streak from the feed
//        op = undismiss (needs key)   — un-hide it
//
// archived holds the full frozen entries (so the archive survives the 180-day
// window that prunes the feed); dismissed holds just the entry keys.

const { getOddstatsStore, CURATION_KEY } = require("./oddstats-blob-store");

const PASSWORD = process.env.STREAK_PASSWORD;
const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-streak-password, content-type",
  "Cache-Control": "no-store",
};
const EMPTY = { archived: [], dismissed: [] };

exports.handler = async (event) => {
  if (!PASSWORD) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: "STREAK_PASSWORD is not set." }) };
  }
  const supplied =
    (event.headers && (event.headers["x-streak-password"] || event.headers["X-Streak-Password"])) || "";
  if (supplied !== PASSWORD) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Wrong password." }) };
  }

  const store = getOddstatsStore();
  let state = (await store.get(CURATION_KEY, { type: "json" }).catch(() => null)) || EMPTY;
  state = { archived: state.archived || [], dismissed: state.dismissed || [] };

  if (event.httpMethod === "GET") {
    return { statusCode: 200, headers: CORS, body: JSON.stringify(state) };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "GET or POST only." }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Bad JSON." }) };
  }
  const { op, key, entry } = body;

  if (op === "archive") {
    if (!entry || !entry.key) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "archive needs an entry." }) };
    if (!state.archived.some((e) => e.key === entry.key)) state.archived.unshift(entry);
  } else if (op === "unarchive") {
    state.archived = state.archived.filter((e) => e.key !== key);
  } else if (op === "dismiss") {
    if (key && !state.dismissed.includes(key)) state.dismissed.push(key);
  } else if (op === "undismiss") {
    state.dismissed = state.dismissed.filter((k) => k !== key);
  } else {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Unknown op." }) };
  }

  // Keep the archive from growing without bound.
  state.archived = state.archived.slice(0, 300);
  state.dismissed = state.dismissed.slice(-1000);

  await store.setJSON(CURATION_KEY, state);
  return { statusCode: 200, headers: CORS, body: JSON.stringify(state) };
};
