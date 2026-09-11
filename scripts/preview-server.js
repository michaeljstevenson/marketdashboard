#!/usr/bin/env node
// Local editable preview server.
// Serves the site as-is, but injects two overlays:
//   - Edit Mode: click into any text and edit it live, logged to
//     preview-edits.json (see that flow in CLAUDE.md).
//   - Markup Mode: an Acrobat-style annotation layer — draw arrows,
//     circles, boxes, freehand marks, and text notes directly on top of
//     the live page to show Claude how something should look. Saved to
//     markup-notes.json, keyed by page path; say "I marked it up" (or
//     similar) and Claude reads that file and applies the changes.
// Both files are git-ignored — this is a communication scratchpad, not
// site content.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EDITS_FILE = path.join(ROOT, 'preview-edits.json');
const MARKUP_FILE = path.join(ROOT, 'markup-notes.json');
const PORT = process.env.PORT || 5555;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const INJECT_SCRIPT = `
<script>
(function() {
  const SAVE_URL = '/__edit__/save';
  let editMode = false;

  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:999999;font-family:-apple-system,sans-serif;';
  bar.innerHTML = '<button id="__editToggle" style="padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);">Edit Mode: Off</button>';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(bar));

  function log(msg, ok) {
    const btn = document.getElementById('__editToggle');
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = old; }, 1500);
  }

  function selectorFor(el) {
    if (el.id) return '#' + el.id;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      let part = node.tagName.toLowerCase();
      if (node.className && typeof node.className === 'string') {
        part += '.' + node.className.trim().split(/\\s+/).join('.');
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function sendEdit(el, oldText, newText) {
    fetch(SAVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page: location.pathname,
        selector: selectorFor(el),
        oldText, newText,
        timestamp: new Date().toISOString(),
      }),
    }).then(() => log('Saved ✓', true)).catch(() => log('Save failed', false));
  }

  const INLINE_TAGS = new Set(['EM','STRONG','B','I','U','SPAN','SUB','SUP','SMALL','MARK','CODE','BR','A']);

  function isTextContainer(el) {
    // allow elements whose only children (if any) are inline formatting tags
    return Array.from(el.children).every(c => INLINE_TAGS.has(c.tagName));
  }

  function hasDirectText(el) {
    return Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim().length > 0);
  }

  function enableEditableEls() {
    const all = document.body.querySelectorAll('*');
    all.forEach(el => {
      if (el.closest('#__editToggle') || el.id === '__editToggle') return;
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
      if (el.closest('[data-__editable="1"]')) return; // don't nest editable regions
      if (!isTextContainer(el)) return;
      if (!hasDirectText(el)) return; // must have its own visible text, not just from children
      el.dataset.__editable = '1';
    });
  }

  function toggle() {
    editMode = !editMode;
    const btn = document.getElementById('__editToggle');
    btn.textContent = 'Edit Mode: ' + (editMode ? 'On' : 'Off');
    btn.style.background = editMode ? '#16a34a' : '#2563eb';
    document.querySelectorAll('[data-__editable="1"]').forEach(el => {
      el.contentEditable = editMode ? 'true' : 'false';
      el.style.outline = editMode ? '1px dashed rgba(37,99,235,.5)' : '';
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    enableEditableEls();
    document.getElementById('__editToggle').addEventListener('click', toggle);

    document.addEventListener('focusin', e => {
      if (editMode && e.target.dataset.__editable === '1') {
        e.target.dataset.__before = e.target.textContent;
      }
    });
    document.addEventListener('focusout', e => {
      if (editMode && e.target.dataset.__editable === '1') {
        const before = e.target.dataset.__before;
        const after = e.target.textContent;
        if (before !== undefined && before !== after) {
          sendEdit(e.target, before, after);
        }
      }
    });
  });
})();
</script>
`;

// Acrobat-style markup layer: an SVG sheet the size of the full document
// (not just the viewport, so marks stay put while scrolling), drawn on
// with Arrow / Circle / Box / Pen / Text tools. Each completed shape is
// saved immediately (whole-state overwrite, not an append log — markup is
// "the current picture", not a diff history) to markup-notes.json keyed
// by page path, and reloaded on page load so a refresh doesn't lose it.
const MARKUP_SCRIPT = `
<script>
(function() {
  const SAVE_URL = '/__markup__/save';
  const LOAD_URL = '/__markup__/load';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const COLORS = ['#e0393e', '#2f6fed', '#2f9e44', '#f0a020', '#ffffff', '#111111'];

  let markupOn = false;
  let currentTool = null; // null = pointer (passthrough) | 'arrow' | 'circle' | 'rect' | 'pen' | 'text'
  let currentColor = COLORS[0];
  let shapes = [];
  let seq = 0;
  let drawing = null;
  let svg = null;
  let toolbar = null;

  function ensureOverlay() {
    if (svg) { resizeOverlay(); return; }
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.id = '__markupSvg';
    svg.style.cssText = 'position:absolute;top:0;left:0;z-index:999997;pointer-events:none;';
    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.innerHTML = '<marker id="__markupArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="context-stroke"/></marker>';
    svg.appendChild(defs);
    document.body.appendChild(svg);
    resizeOverlay();
    window.addEventListener('resize', resizeOverlay);
  }

  function resizeOverlay() {
    if (!svg) return;
    const w = document.documentElement.scrollWidth, h = document.documentElement.scrollHeight;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.style.width = w + 'px';
    svg.style.height = h + 'px';
  }

  function pagePoint(e) {
    return { x: Math.round(e.pageX), y: Math.round(e.pageY) };
  }

  function shapeEl(s) {
    let el;
    if (s.type === 'arrow') {
      el = document.createElementNS(SVG_NS, 'line');
      el.setAttribute('x1', s.x1); el.setAttribute('y1', s.y1);
      el.setAttribute('x2', s.x2); el.setAttribute('y2', s.y2);
      el.setAttribute('stroke', s.color); el.setAttribute('stroke-width', 2.5);
      el.setAttribute('marker-end', 'url(#__markupArrow)');
    } else if (s.type === 'circle') {
      el = document.createElementNS(SVG_NS, 'ellipse');
      el.setAttribute('cx', (s.x1 + s.x2) / 2); el.setAttribute('cy', (s.y1 + s.y2) / 2);
      el.setAttribute('rx', Math.abs(s.x2 - s.x1) / 2); el.setAttribute('ry', Math.abs(s.y2 - s.y1) / 2);
      el.setAttribute('fill', 'none'); el.setAttribute('stroke', s.color); el.setAttribute('stroke-width', 2.5);
    } else if (s.type === 'rect') {
      el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('x', Math.min(s.x1, s.x2)); el.setAttribute('y', Math.min(s.y1, s.y2));
      el.setAttribute('width', Math.abs(s.x2 - s.x1)); el.setAttribute('height', Math.abs(s.y2 - s.y1));
      el.setAttribute('fill', 'none'); el.setAttribute('stroke', s.color); el.setAttribute('stroke-width', 2.5);
    } else if (s.type === 'pen') {
      el = document.createElementNS(SVG_NS, 'polyline');
      el.setAttribute('points', s.points.map((p) => p.x + ',' + p.y).join(' '));
      el.setAttribute('fill', 'none'); el.setAttribute('stroke', s.color); el.setAttribute('stroke-width', 2.5);
      el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round');
    } else if (s.type === 'text') {
      el = document.createElementNS(SVG_NS, 'text');
      el.setAttribute('x', s.x1); el.setAttribute('y', s.y1);
      el.setAttribute('fill', s.color); el.setAttribute('font-size', '15');
      el.setAttribute('font-family', '-apple-system,sans-serif'); el.setAttribute('font-weight', '700');
      el.setAttribute('paint-order', 'stroke'); el.setAttribute('stroke', '#ffffff'); el.setAttribute('stroke-width', '3');
      el.textContent = s.text;
    }
    el.dataset.shape = s.id;
    return el;
  }

  function renderAll() {
    ensureOverlay();
    Array.from(svg.querySelectorAll('[data-shape]')).forEach((n) => n.remove());
    shapes.forEach((s) => svg.appendChild(shapeEl(s)));
  }

  function setStatus(msg) {
    const el = document.getElementById('__markupStatus');
    if (!el) return;
    el.textContent = msg;
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 1600);
  }

  function save() {
    fetch(SAVE_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: location.pathname, shapes: shapes, updated: new Date().toISOString() }),
    }).then(() => setStatus('Saved ✓')).catch(() => setStatus('Save failed'));
  }

  function load() {
    fetch(LOAD_URL + '?page=' + encodeURIComponent(location.pathname))
      .then((r) => r.json())
      .then((d) => { shapes = (d && d.shapes) || []; seq = shapes.length; renderAll(); })
      .catch(() => {});
  }

  function addShape(partial) {
    const s = Object.assign({ id: 'm' + seq++, color: currentColor }, partial);
    shapes.push(s);
    svg.appendChild(shapeEl(s));
    save();
  }

  function undo() {
    const s = shapes.pop();
    if (!s) return;
    const el = svg.querySelector('[data-shape="' + s.id + '"]');
    if (el) el.remove();
    save();
  }

  function clearAll() {
    if (shapes.length && !confirm('Clear all markup on this page?')) return;
    shapes = [];
    renderAll();
    save();
  }

  function selectTool(tool) {
    currentTool = tool === 'pointer' ? null : tool;
    document.body.style.cursor = currentTool ? 'crosshair' : '';
    document.querySelectorAll('.__markupToolBtn').forEach((b) => {
      b.style.background = (b.dataset.tool === tool) ? '#16a34a' : '#333';
    });
  }

  function onPointerDown(e) {
    if (!currentTool) return;
    e.preventDefault(); e.stopPropagation();
    const p = pagePoint(e);
    if (currentTool === 'text') {
      const text = prompt('Note text:');
      if (text) addShape({ type: 'text', x1: p.x, y1: p.y, text: text });
      selectTool('pointer');
      return;
    }
    drawing = currentTool === 'pen' ? { type: 'pen', points: [p] } : { type: currentTool, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  }

  function onPointerMove(e) {
    if (!drawing) return;
    e.preventDefault(); e.stopPropagation();
    const p = pagePoint(e);
    if (drawing.type === 'pen') drawing.points.push(p);
    else { drawing.x2 = p.x; drawing.y2 = p.y; }
    const prev = svg.querySelector('[data-shape="__preview"]');
    if (prev) prev.remove();
    svg.appendChild(shapeEl(Object.assign({ id: '__preview', color: currentColor }, drawing)));
  }

  function onPointerUp(e) {
    if (!drawing) return;
    e.preventDefault(); e.stopPropagation();
    const prev = svg.querySelector('[data-shape="__preview"]');
    if (prev) prev.remove();
    const d = drawing; drawing = null;
    const tooSmall = d.type === 'pen' ? d.points.length < 2 : Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 4;
    if (!tooSmall) addShape(d);
    selectTool('pointer'); // one shape per tool pick, then back to passthrough
  }

  function buildToggle() {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;bottom:16px;right:150px;z-index:999999;font-family:-apple-system,sans-serif;';
    bar.innerHTML = '<button id="__markupToggle" style="padding:10px 16px;border-radius:8px;border:none;background:#7c3aed;color:#fff;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);">Markup: Off</button>';
    document.body.appendChild(bar);
    document.getElementById('__markupToggle').addEventListener('click', toggleMarkup);
  }

  function buildToolbar() {
    toolbar = document.createElement('div');
    toolbar.id = '__markupToolbar';
    toolbar.style.cssText = 'position:fixed;bottom:60px;right:150px;z-index:999998;display:none;flex-direction:column;gap:8px;background:#1c1c1c;border:1px solid #444;border-radius:10px;padding:10px;width:190px;font-family:-apple-system,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5);';

    const hint = document.createElement('div');
    hint.textContent = 'Pick a tool, draw on the page.';
    hint.style.cssText = 'font-size:11px;color:#9ca3af;';

    const toolRow = document.createElement('div');
    toolRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
    [['pointer', '↖ Pointer'], ['arrow', '↗ Arrow'], ['circle', '○ Circle'], ['rect', '▭ Box'], ['pen', '✎ Pen'], ['text', 'T Text']].forEach(([id, label]) => {
      const b = document.createElement('button');
      b.className = '__markupToolBtn';
      b.dataset.tool = id;
      b.textContent = label;
      b.style.cssText = 'padding:6px 8px;border-radius:6px;border:0;background:#333;color:#fff;font-size:12px;cursor:pointer;';
      b.addEventListener('click', () => selectTool(id));
      toolRow.appendChild(b);
    });

    const colorRow = document.createElement('div');
    colorRow.style.cssText = 'display:flex;gap:5px;';
    COLORS.forEach((c) => {
      const b = document.createElement('button');
      b.title = c;
      b.style.cssText = 'width:22px;height:22px;border-radius:50%;border:2px solid ' + (c === currentColor ? '#fff' : 'transparent') + ';background:' + c + ';cursor:pointer;';
      b.addEventListener('click', () => {
        currentColor = c;
        colorRow.querySelectorAll('button').forEach((x) => (x.style.borderColor = 'transparent'));
        b.style.borderColor = '#fff';
      });
      colorRow.appendChild(b);
    });

    const actionRow = document.createElement('div');
    actionRow.style.cssText = 'display:flex;gap:4px;';
    const btnStyle = 'flex:1;padding:6px;border-radius:6px;border:0;background:#333;color:#fff;font-size:12px;cursor:pointer;';
    const undoBtn = document.createElement('button');
    undoBtn.textContent = 'Undo'; undoBtn.style.cssText = btnStyle; undoBtn.addEventListener('click', undo);
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear'; clearBtn.style.cssText = btnStyle; clearBtn.addEventListener('click', clearAll);
    actionRow.appendChild(undoBtn); actionRow.appendChild(clearBtn);

    const status = document.createElement('div');
    status.id = '__markupStatus';
    status.style.cssText = 'font-size:11px;color:#9ca3af;min-height:14px;';

    toolbar.appendChild(hint);
    toolbar.appendChild(toolRow);
    toolbar.appendChild(colorRow);
    toolbar.appendChild(actionRow);
    toolbar.appendChild(status);
    document.body.appendChild(toolbar);
  }

  function toggleMarkup() {
    markupOn = !markupOn;
    const btn = document.getElementById('__markupToggle');
    btn.textContent = 'Markup: ' + (markupOn ? 'On' : 'Off');
    btn.style.background = markupOn ? '#16a34a' : '#7c3aed';
    toolbar.style.display = markupOn ? 'flex' : 'none';
    if (!markupOn) selectTool('pointer');
  }

  document.addEventListener('DOMContentLoaded', () => {
    buildToggle();
    buildToolbar();
    ensureOverlay();
    load();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
  });
})();
</script>
`;

function send404(res) {
  res.writeHead(404);
  res.end('Not found');
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/__edit__/save' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const edit = JSON.parse(body);
        let edits = [];
        if (fs.existsSync(EDITS_FILE)) {
          edits = JSON.parse(fs.readFileSync(EDITS_FILE, 'utf8'));
        }
        edits.push(edit);
        fs.writeFileSync(EDITS_FILE, JSON.stringify(edits, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  if (url.pathname === '/__markup__/save' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body); // { page, shapes, updated }
        const all = readJsonFile(MARKUP_FILE);
        all[payload.page] = { shapes: payload.shapes, updated: payload.updated };
        fs.writeFileSync(MARKUP_FILE, JSON.stringify(all, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  if (url.pathname === '/__markup__/load' && req.method === 'GET') {
    const all = readJsonFile(MARKUP_FILE);
    const entry = all[url.searchParams.get('page')] || { shapes: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entry));
    return;
  }

  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(ROOT, decodeURIComponent(filePath));

  if (!filePath.startsWith(ROOT)) return send404(res);

  fs.readFile(filePath, (err, data) => {
    if (err) return send404(res);
    const ext = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';

    if (ext === '.html') {
      let html = data.toString('utf8');
      const overlays = INJECT_SCRIPT + MARKUP_SCRIPT;
      html = html.includes('</body>')
        ? html.replace('</body>', overlays + '</body>')
        : html + overlays;
      res.writeHead(200, { 'Content-Type': mime });
      res.end(html);
    } else {
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Editable preview running at http://localhost:${PORT}`);
  console.log(`Text edits are logged to ${EDITS_FILE}`);
  console.log(`Markup (Acrobat-style annotations) is logged to ${MARKUP_FILE}`);
});
