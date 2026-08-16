#!/usr/bin/env node
// Local editable preview server.
// Serves the site as-is, but injects an edit overlay so changes made in the
// browser get logged to preview-edits.json instead of touching real files.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EDITS_FILE = path.join(ROOT, 'preview-edits.json');
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

function send404(res) {
  res.writeHead(404);
  res.end('Not found');
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

  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(ROOT, decodeURIComponent(filePath));

  if (!filePath.startsWith(ROOT)) return send404(res);

  fs.readFile(filePath, (err, data) => {
    if (err) return send404(res);
    const ext = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';

    if (ext === '.html') {
      let html = data.toString('utf8');
      html = html.includes('</body>')
        ? html.replace('</body>', INJECT_SCRIPT + '</body>')
        : html + INJECT_SCRIPT;
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
  console.log(`Edits are logged to ${EDITS_FILE}`);
});
