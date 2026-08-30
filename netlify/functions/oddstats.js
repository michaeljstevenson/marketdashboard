// Serves the pre-computed streak-scanner board (computed daily by
// scheduled-oddstats-background.js, stored in Netlify Blobs). This function
// makes no outbound calls — it just reads the blob.
//
// The page is gated: the request must carry the shared password, either as an
// "x-streak-password" header or a "password" query param. The check is
// server-side, so the blob can't be scraped without it. The password lives
// only in the Netlify environment (STREAK_PASSWORD) — there is no default, so
// the endpoint stays locked until that variable is set.

const { getOddstatsStore, BLOB_KEY } = require("./oddstats-blob-store");

const PASSWORD = process.env.STREAK_PASSWORD;

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-streak-password, content-type",
  "Cache-Control": "no-store",
};

exports.handler = async (event) => {
  if (!PASSWORD) {
    return {
      statusCode: 503,
      headers: CORS,
      body: JSON.stringify({ error: "STREAK_PASSWORD is not set in the Netlify environment." }),
    };
  }

  const supplied =
    (event.headers && (event.headers["x-streak-password"] || event.headers["X-Streak-Password"])) ||
    (event.queryStringParameters && event.queryStringParameters.password) ||
    "";

  if (supplied !== PASSWORD) {
    return {
      statusCode: 401,
      headers: CORS,
      body: JSON.stringify({ error: "Wrong password." }),
    };
  }

  try {
    const store = getOddstatsStore();
    const board = await store.get(BLOB_KEY, { type: "json" });
    if (!board) {
      throw new Error("Board not populated yet — scheduled-oddstats-background hasn't run.");
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify(board) };
  } catch (err) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
