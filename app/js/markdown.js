/* Markdown + mermaid pipeline: marked -> DOMPurify -> mermaid placeholders -> async diagram paint.
   Libraries are vendored in js/vendor/ (zero network). Fails closed: if marked or DOMPurify is missing,
   text is shown escaped in <pre class="md-raw">, never as unsanitized HTML. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Markdown = api;
})(typeof window !== 'undefined' ? window : this, function (root) {
  'use strict';
  const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ENT[c]);
  // marked escapes & < > " ' inside code; undo exactly those five (ampersand last).
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&');
  const NOTE = '<div class="md-note" role="status">Formatting unavailable (markdown library failed to load)</div>';
  const markedOK = () => !!root.marked && typeof root.marked.parse === 'function';
  const mermaidOK = () => !!root.mermaid && typeof root.mermaid.render === 'function';

  // DOMPurify is a factory in browsers (needs a window); resolve the instance once.
  let purifier;
  function purify() {
    if (purifier !== undefined) return purifier;
    const D = root.DOMPurify;
    purifier = null;
    try {
      if (D && typeof D.sanitize === 'function') purifier = D;
      else if (typeof D === 'function') { const p = D(root); if (p && typeof p.sanitize === 'function') purifier = p; }
    } catch (e) { purifier = null; }
    return purifier;
  }
  const ready = () => ({ marked: markedOK(), dompurify: !!purify(), mermaid: mermaidOK() });
  const raw = (t) => (t.trim() ? NOTE + '<pre class="md-raw">' + esc(t) + '</pre>' : '');

  // one criterion/item per line -> markdown bullets
  const listify = (t) => t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => '- ' + l.replace(/^[-*+]\s+/, '')).join('\n');

  function render(md, opts) {
    opts = opts || {};
    let t = String(md == null ? '' : md);
    if (opts.list) t = listify(t);
    if (!markedOK() || !purify()) return raw(t);
    try {
      let html = purify().sanitize(root.marked.parse(t, { breaks: true }), { ADD_ATTR: ['target'] });
      html = html.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g, (m, code) =>
        '<div class="mm-wait" data-mm data-src="' + esc(unesc(code).replace(/\n$/, '')) + '">Rendering diagram…</div>');
      if (opts.list) html = html.replace(/^<ul>/, '<ul class="ac">');
      return html;
    } catch (e) { return raw(t); }
  }

  function inline(md) {
    const t = String(md == null ? '' : md);
    if (!markedOK() || !purify()) return esc(t);
    try { return purify().sanitize(root.marked.parseInline(t), { ADD_ATTR: ['target'] }); } catch (e) { return esc(t); }
  }

  // ---- mermaid: one init, serialized renders, code -> svg cache (null = failed) ----
  const cache = new Map();
  let inited = false, seq = 0, queue = Promise.resolve();
  function svgFor(code) {
    if (cache.has(code)) return Promise.resolve(cache.get(code));
    const job = queue.then(async () => {
      const id = 'mm' + (++seq);
      try {
        if (!mermaidOK()) throw new Error('mermaid unavailable');
        if (!inited) {
          root.mermaid.initialize({ startOnLoad: false, theme: 'base', themeVariables: { primaryColor: '#eef2ff', primaryBorderColor: '#6366f1', primaryTextColor: '#1e1b4b', lineColor: '#6366f1', textColor: '#334155' } });
          inited = true;
        }
        const r = await root.mermaid.render(id, code);
        cache.set(code, r.svg);
      } catch (e) {
        cache.set(code, null);
        const d = root.document && root.document.getElementById('d' + id); if (d) d.remove(); // mermaid leaves a temp node on error
      }
      return cache.get(code);
    });
    queue = job.catch(() => {});
    return job;
  }
  async function paintMermaid(rootEl) {
    try {
      if (!rootEl || !rootEl.querySelectorAll) return;
      const els = Array.from(rootEl.querySelectorAll('[data-mm]'));
      for (const el of els) {
        const code = el.getAttribute('data-src') || '', svg = await svgFor(code);
        if (!el.isConnected) continue;
        const d = root.document.createElement('div');
        if (svg) { d.className = 'mm'; d.setAttribute('role', 'img'); d.setAttribute('aria-label', 'Diagram'); d.innerHTML = svg; }
        else { d.className = 'mm-fail'; d.innerHTML = '<pre><code>' + esc(code) + '</code></pre><div class="md-note" role="status">diagram failed to render</div>'; }
        el.replaceWith(d);
      }
    } catch (e) { /* never throw */ }
  }

  return { render, inline, paintMermaid, ready, esc };
});
