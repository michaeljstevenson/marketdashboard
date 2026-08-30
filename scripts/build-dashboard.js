// Builds the Streak Scanner front-end from streak-scanner.template.html.
//
// Scanner page (password-gated, fetches /api/oddstats at runtime):
//   node scripts/build-dashboard.js --page streak-scanner.html
//
// Archive page (password-gated, fetches /api/oddstats-curation only):
//   node scripts/build-dashboard.js --archive streak-archive.html
//
// Standalone artifact (data baked in, no password, localStorage curation):
//   node scripts/oddstats-detect.js --dump > snap.json
//   node scripts/build-dashboard.js snap.json scripts/streak-scanner.html
//
// The template carries a __BOOT__ placeholder; each mode swaps in its own
// bootstrap. Everything else (styles, render logic) is shared.

const fs = require("fs");

const tpl = fs.readFileSync(__dirname + "/streak-scanner.template.html", "utf8");
const args = process.argv.slice(2);
const NOINDEX = '<title>Streak Scanner</title>\n<meta name="robots" content="noindex,nofollow">';

function emit(outPath, html) {
  fs.writeFileSync(outPath, html);
  console.log("wrote", outPath, fs.statSync(outPath).size, "bytes");
}

// A password gate that validates against `endpoint`; on success runs `onOk`
// (a statement string) with the parsed response available as `payload`.
function gateBoot(endpoint, onOk) {
  return `
(function(){
  const gate = el('gate'), form = el('gateform'), pwIn = el('gatepw'), errEl = el('gateerr');
  function say(msg, loading){ errEl.textContent = msg || ''; errEl.className = 'gateerr' + (loading ? ' loading' : ''); }
  async function tryPw(pw){
    say('Checking\\u2026', true);
    let res;
    try { res = await fetch('${endpoint}', { headers: { 'x-streak-password': pw }, cache: 'no-store' }); }
    catch(e){ say('Network error \\u2014 try again.'); return; }
    if(res.status === 401){ try{ sessionStorage.removeItem('ss_pw'); }catch(e){} say('Wrong password.'); pwIn.select(); return; }
    if(!res.ok){ const j = await res.json().catch(function(){ return {}; }); say(j.error || ('Error ' + res.status)); return; }
    const payload = await res.json();
    try{ sessionStorage.setItem('ss_pw', pw); }catch(e){}
    say('');
    gate.hidden = true; gate.style.display = 'none';
    el('app').hidden = false;
    ${onOk}
  }
  form.addEventListener('submit', function(e){ e.preventDefault(); if(pwIn.value) tryPw(pwIn.value); });
  var saved = null; try{ saved = sessionStorage.getItem('ss_pw'); }catch(e){}
  if(saved) tryPw(saved);
})();`;
}

const mode = args[0];

if (mode === "--page") {
  const out = args[1] || "streak-scanner.html";
  const boot = gateBoot("/api/oddstats", "DATA = payload; init();");
  emit(out, tpl.replace("__BOOT__", () => boot).replace("<title>Streak Scanner</title>", NOINDEX));
} else if (mode === "--archive") {
  const out = args[1] || "streak-archive.html";
  const boot = gateBoot(
    "/api/oddstats-curation",
    "CURATION = payload; curationVia = 'server'; initArchive();"
  );
  emit(out, tpl.replace("__BOOT__", () => boot).replace("<title>Streak Scanner</title>", NOINDEX));
} else {
  const dataPath = args[0];
  const outPath = args[1];
  if (!dataPath || !outPath) {
    console.error("usage: build-dashboard.js --page <out> | --archive <out> | <dump.json> <out>");
    process.exit(1);
  }
  const data = fs.readFileSync(dataPath, "utf8").trim();
  JSON.parse(data);
  const boot =
    `window.__noNav = true;\nDATA = ${data};\n` +
    `var g = el('gate'); if(g) g.remove();\nel('app').hidden = false;\ninit();`;
  emit(outPath, tpl.replace("__BOOT__", () => boot));
}
