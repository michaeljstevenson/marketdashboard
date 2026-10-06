// Gates /preview/* (unmerged PR pages staged for review on the live site)
// behind the Statistical Engine's password. The Statistical Engine only gates
// its data API, but preview pages are static HTML, so the check has to happen
// here, before Netlify serves the file.
//
// A correct password sets an HttpOnly cookie holding a hash of the password,
// so changing STREAK_PASSWORD in Netlify signs every browser out. The
// Statistical Engine page posts to /preview/login when it unlocks, so one
// password entry covers both.

const COOKIE = "preview_auth";
const MAX_AGE = 30 * 86400;

async function tokenFor(password) {
  const bytes = new TextEncoder().encode("preview:" + password);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeNext(next) {
  return typeof next === "string" && /^\/preview(\/[A-Za-z0-9._\/-]*)?$/.test(next) ? next : "/preview/";
}

function loginPage(next, error, status) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Previews | Michael J. Stevenson</title>
<style>
:root{--ground:#f4f3ef;--surface:#fbfaf7;--ink:#1b1e1c;--ink-dim:#5c5f59;--line:#e2dfd5;--neg:#b3412f}
@media (prefers-color-scheme:dark){:root{--ground:#16150f;--surface:#1e1d17;--ink:#ece9e1;--ink-dim:#9a978c;--line:#33302a;--neg:#e0705c}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--ground);color:var(--ink);font-family:"IBM Plex Sans",system-ui,sans-serif}
form{width:min(340px,90vw);display:flex;flex-direction:column;gap:12px;text-align:center;padding:0 16px}
h1{font-size:1.6rem;font-weight:600;margin:0}
p{color:var(--ink-dim);font-size:.9rem;margin:0 0 4px}
input{font:inherit;font-size:1rem;text-align:center;padding:10px 12px;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:8px}
button{font:inherit;font-size:.95rem;padding:10px 12px;cursor:pointer;background:var(--ink);color:var(--ground);border:0;border-radius:8px}
.err{color:var(--neg);font-size:.85rem;min-height:1.2em}
</style></head><body>
<form method="post" action="/preview/login">
<h1>Previews</h1>
<p>Michael J. Stevenson &middot; enter the password to view.</p>
<input type="hidden" name="next" value="${esc(next)}">
<input type="password" name="password" aria-label="Password" autocomplete="current-password" autofocus>
<button type="submit">Unlock</button>
<div class="err">${esc(error)}</div>
</form></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export default async (request, context) => {
  const password = Netlify.env.get("STREAK_PASSWORD");
  if (!password) return new Response("Previews are locked: STREAK_PASSWORD is not set.", { status: 503 });
  const token = await tokenFor(password);
  const url = new URL(request.url);

  if (url.pathname === "/preview/login") {
    if (request.method !== "POST") return Response.redirect(new URL("/preview/", url), 303);
    const form = await request.formData().catch(() => null);
    const next = safeNext(form && form.get("next"));
    if (!form || form.get("password") !== password) return loginPage(next, "Wrong password.", 401);
    return new Response(null, {
      status: 303,
      headers: {
        location: next,
        "set-cookie": `${COOKIE}=${token}; Path=/preview; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
        "cache-control": "no-store",
      },
    });
  }

  if (context.cookies.get(COOKIE) === token) {
    const res = await context.next();
    res.headers.set("cache-control", "private, no-store");
    res.headers.set("x-robots-tag", "noindex");
    return res;
  }
  return loginPage(safeNext(url.pathname), "", 401);
};

export const config = { path: ["/preview", "/preview/*"] };
