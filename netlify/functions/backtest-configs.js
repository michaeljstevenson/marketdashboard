// Save/list/delete named backtest configurations for /backtesting.html,
// backed by Netlify Blobs. GET returns all saved configs; POST upserts one
// (by name); DELETE removes one (?name=...). There's no per-user auth on
// this site, so this is a single shared list, same trust model as the
// rest of this site's Blobs-backed state.

const { getBacktestStore, BLOB_KEY } = require("./backtest-blob-store");

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function readAll(store) {
  const payload = await store.get(BLOB_KEY, { type: "json" });
  return (payload && Array.isArray(payload.configs)) ? payload.configs : [];
}

exports.handler = async (event) => {
  const store = getBacktestStore();

  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    if (event.httpMethod === "GET") {
      const configs = await readAll(store);
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ configs }) };
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const name = (body.name || "").trim();
      if (!name) throw new Error("Missing required 'name' field");
      if (name.length > 80) throw new Error("Name too long (max 80 characters)");

      const configs = await readAll(store);
      const entry = { name, params: body.params || {}, savedAt: new Date().toISOString() };
      const idx = configs.findIndex((c) => c.name === name);
      if (idx >= 0) configs[idx] = entry;
      else configs.push(entry);

      await store.setJSON(BLOB_KEY, { configs });
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ configs }) };
    }

    if (event.httpMethod === "DELETE") {
      const name = (event.queryStringParameters && event.queryStringParameters.name || "").trim();
      if (!name) throw new Error("Missing required 'name' query parameter");

      const configs = (await readAll(store)).filter((c) => c.name !== name);
      await store.setJSON(BLOB_KEY, { configs });
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ configs }) };
    }

    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: "Method not allowed" }) };
  } catch (err) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
