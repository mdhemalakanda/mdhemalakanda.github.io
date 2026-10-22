/*
 * TeamzLab FedEx docs: self-hosted search + docs assistant.
 * Mintlify static exports ship no search backend (the stock modal shows
 * "Run mint login in the cli to activate search") and no Ask-AI widget.
 * This script adds a client-side search over /_custom/search-index.json
 * and a retrieval-grounded assistant, optionally backed by a real LLM
 * endpoint configured in /_custom/ai-config.json.
 */
(function () {
  'use strict';

  /* ---------- base path (works at site root or any sub-path) ---------- */
  function detectBase() {
    var probe = document.querySelector('script[src*="_next/static/"]');
    if (probe) {
      var i = probe.src.indexOf('_next/');
      if (i > -1) return probe.src.slice(0, i);
    }
    return '/';
  }
  var BASE = detectBase();

  function loadCss() {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = BASE + '_custom/docs-plus.css';
    document.head.appendChild(link);
  }

  /* ---------- search index ---------- */
  var indexPromise = null;
  function getIndex() {
    if (!indexPromise) {
      indexPromise = fetch(BASE + '_custom/search-index.json')
        .then(function (r) { return r.json(); })
        .catch(function () { return []; });
    }
    return indexPromise;
  }

  var STOP = {};
  'a an the is are was were be been this that these those how what when where why which who '
  .split(' ').forEach(function (w) { STOP[w] = 1; });
  'do does did i you your we our it its of in on at to for with from by and or not can could '
  'should would will may might must have has had my me if then than as'.split(' ').forEach(function (w) { STOP[w] = 1; });

  function tokens(q) {
    return q.toLowerCase().split(/[^a-z0-9_.-]+/).filter(function (t) {
      return t.length > 1;
    });
  }

  function meaningful(toks) {
    return toks.filter(function (t) { return !STOP[t]; });
  }

  function scoreSection(page, sec, toks, raw) {
    // Returns matched-token count (with weighted score folded in); -1 if nothing matches.
    var t = page.t.toLowerCase(), h = (sec.h || '').toLowerCase(), b = (sec.b || '').toLowerCase();
    var score = 0, matched = 0;
    for (var k = 0; k < toks.length; k++) {
      var tok = toks[k];
      var inT = t.indexOf(tok) > -1, inH = h.indexOf(tok) > -1, inB = b.indexOf(tok) > -1;
      if (inT || inH || inB) matched++;
      if (inT) score += 120;
      if (inH) score += 45;
      if (inB) score += 2;
    }
    if (!matched) return -1;
    if (raw && raw.length > 2) {
      if (t.indexOf(raw.toLowerCase()) > -1) score += 150;
      if (h.indexOf(raw.toLowerCase()) > -1) score += 60;
    }
    if (page.u === '/') score += 10;
    return score + matched * 25;
  }

  function snippet(text, toks) {
    var lower = text.toLowerCase(), at = -1;
    for (var k = 0; k < toks.length; k++) {
      var i = lower.indexOf(toks[k]);
      if (i > -1 && (at === -1 || i < at)) at = i;
    }
    if (at === -1) at = 0;
    var start = Math.max(0, at - 60);
    var out = (start > 0 ? '…' : '') + text.slice(start, start + 180);
    if (start + 180 < text.length) out += '…';
    return out;
  }

  function highlight(el, text, toks) {
    var safe = document.createElement('div');
    safe.textContent = text;
    var html = safe.innerHTML, lower = html.toLowerCase();
    toks.forEach(function (tok) {
      var i = lower.indexOf(tok);
      if (i > -1) {
        html = html.slice(0, i) + '<mark>' + html.slice(i, i + tok.length) + '</mark>' + html.slice(i + tok.length);
        lower = html.toLowerCase();
      }
    });
    el.innerHTML = html;
  }

  function search(query, pages) {
    var toks = tokens(query);
    if (!toks.length) return [];
    var must = meaningful(toks);
    if (!must.length) must = toks;
    var out = [];
    pages.forEach(function (page) {
      page.s.forEach(function (sec) {
        var sc = scoreSection(page, sec, must, query);
        if (sc > 0) out.push({ page: page, sec: sec, score: sc });
      });
    });

    function dedupe(list) {
      var seen = {};
      return list.filter(function (r) {
        var key = r.page.u + '#' + (r.sec.i || r.sec.h);
        if (seen[key]) return false;
        seen[key] = 1;
        return true;
      });
    }

    if (!out.length && must.length > 1) {
      // relaxed: sections matching a good share of the meaningful tokens
      var relaxed = [];
      pages.forEach(function (page) {
        page.s.forEach(function (sec) {
          var t = page.t.toLowerCase(), h = (sec.h || '').toLowerCase(), b = (sec.b || '').toLowerCase();
          var hits = must.filter(function (tok) {
            return t.indexOf(tok) > -1 || h.indexOf(tok) > -1 || b.indexOf(tok) > -1;
          });
          var need = Math.min(must.length - 1, Math.max(2, Math.ceil(must.length / 2)));
          if (hits.length >= need) {
            relaxed.push({ page: page, sec: sec, score: hits.length * 100, matched: hits.length });
          }
        });
      });
      out = relaxed;
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return dedupe(out).slice(0, 12);
  }

  /* ---------- search modal ---------- */
  var modal, inputEl, listEl, results = [], active = -1;

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  function buildModal() {
    modal = el('div', 'dp-overlay dp-hidden');
    modal.addEventListener('mousedown', function (e) { if (e.target === modal) close(); });
    var panel = el('div', 'dp-panel', modal);
    var head = el('div', 'dp-input-row', panel);
    inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.placeholder = 'Search the docs…';
    inputEl.className = 'dp-input';
    head.appendChild(inputEl);
    var esc = el('span', 'dp-esc', head);
    esc.textContent = 'esc';
    listEl = el('div', 'dp-results', panel);
    var foot = el('div', 'dp-foot', panel);
    foot.innerHTML = '<span>↑↓ navigate</span><span>↵ open</span><span>esc close</span>';
    inputEl.addEventListener('input', runSearch);
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { move(1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { move(-1); e.preventDefault(); }
      else if (e.key === 'Enter') {
        if (active === -1 && results.length) go(0);
        else if (active > -1) go(active);
      }
      else if (e.key === 'Escape') { close(); }
    });
    document.body.appendChild(modal);
  }

  var pollTimer = null, lastQuery = null;

  function startPolling() {
    // Belt-and-suspenders: some environments swallow per-element input events,
    // so watch the value directly while the modal is open.
    if (pollTimer) return;
    lastQuery = null;
    pollTimer = setInterval(function () {
      if (!modal || modal.classList.contains('dp-hidden')) return;
      var v = inputEl.value;
      if (v !== lastQuery) {
        lastQuery = v;
        runSearch();
      }
    }, 120);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    lastQuery = null;
  }

  function open() {
    if (!modal) buildModal();
    modal.classList.remove('dp-hidden');
    inputEl.value = '';
    listEl.innerHTML = '<div class="dp-empty">Type to search all 36 pages.</div>';
    inputEl.focus();
    startPolling();
  }

  function close() {
    if (modal) modal.classList.add('dp-hidden');
    stopPolling();
    results = [];
    active = -1;
  }

  function runSearch() {
    var q = inputEl.value.trim();
    if (q.length < 2) {
      listEl.innerHTML = '<div class="dp-empty">Type to search all 36 pages.</div>';
      return;
    }
    getIndex().then(function (pages) {
      if (inputEl.value.trim() !== q) return; // stale
      results = search(q, pages);
      listEl.innerHTML = '';
      active = -1;
      if (!results.length) {
        listEl.innerHTML = '<div class="dp-empty">No results for “' + q.replace(/[<>&]/g, '') + '”.</div>';
        return;
      }
      var toks = tokens(q);
      results.forEach(function (r, idx) {
        var item = el('a', 'dp-item', listEl);
        item.href = r.page.u + (r.sec.i ? '#' + r.sec.i : '');
        item.setAttribute('data-dp-idx', idx);
        var crumb = el('div', 'dp-item-crumb', item);
        highlight(crumb, r.page.t, toks);
        if (r.sec.h && r.sec.h !== r.page.t) {
          var head = el('div', 'dp-item-head', item);
          highlight(head, r.sec.h, toks);
        }
        if (r.sec.b) {
          var sn = el('div', 'dp-item-snip', item);
          highlight(sn, snippet(r.sec.b, toks), toks);
        }
      });
    });
  }

  function move(d) {
    if (!results.length) return;
    active = (active + d + results.length) % results.length;
    var items = listEl.querySelectorAll('.dp-item');
    for (var i = 0; i < items.length; i++) items[i].classList.toggle('dp-active', i === active);
    if (items[active]) items[active].scrollIntoView({ block: 'nearest' });
  }

  function go(idx) {
    var r = results[idx];
    if (r) window.location.href = r.page.u + (r.sec.i ? '#' + r.sec.i : '');
    close();
  }

  /* ---------- hijack the stock (broken) search triggers ---------- */
  function isSearchTrigger(btn) {
    if (!btn || btn.tagName !== 'BUTTON') return false;
    var txt = (btn.textContent || '').toLowerCase();
    return txt.indexOf('search') > -1 && (txt.indexOf('k') > -1 || txt.length < 40);
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button') : null;
    if (isSearchTrigger(btn)) {
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  }, true);

  document.addEventListener('keydown', function (e) {
    var meta = e.metaKey || e.ctrlKey;
    if (meta && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      e.stopPropagation();
      open();
    } else if (e.key === '/' && !meta) {
      var t = e.target;
      var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (!typing) { e.preventDefault(); e.stopPropagation(); open(); }
    }
  }, true);

  document.addEventListener('keydown', function (e) {
    var modalOpen = modal && !modal.classList.contains('dp-hidden');
    if (modalOpen) {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'ArrowDown') { move(1); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { move(-1); e.preventDefault(); return; }
      if (e.key === 'Enter') {
        if (active === -1 && results.length) go(0);
        else if (active > -1) go(active);
        return;
      }
    }
    if (panel && !panel.classList.contains('dp-hidden') && e.key === 'Enter' &&
        document.activeElement === aiInput) {
      ask();
    }
  });

  /* ---------- retrieval assistant (Ask AI) ---------- */
  var aiConfig = { endpoint: null };
  fetch(BASE + '_custom/ai-config.json')
    .then(function (r) { return r.json(); })
    .then(function (c) { aiConfig = c || { endpoint: null }; })
    .catch(function () {});

  var fab, panel, msgs, aiInput;

  function mdLite(text) {
    var safe = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');
    safe = safe.replace(/\n/g, '<br>');
    return safe;
  }

  function buildAssistant() {
    fab = el('button', 'dp-fab');
    fab.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"/></svg><span>Ask AI</span>';
    fab.title = 'Ask the docs';

    panel = el('div', 'dp-ai dp-hidden');
    var head = el('div', 'dp-ai-head', panel);
    var title = el('div', 'dp-ai-title', head);
    title.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"/></svg> Docs Assistant';
    var closeBtn = el('button', 'dp-ai-close', head);
    closeBtn.textContent = '×';

    msgs = el('div', 'dp-ai-msgs', panel);
    var hello = el('div', 'dp-ai-bubble dp-ai-bot', msgs);
    hello.innerHTML = 'Hi! Ask me anything about <strong>TeamzLab FedEx Shipping</strong> — setup, rates, labels, tracking, returns. I point you to the right section of the docs.';

    var row = el('div', 'dp-ai-row', panel);
    aiInput = document.createElement('input');
    aiInput.className = 'dp-ai-input';
    aiInput.placeholder = 'e.g. How do I enable freight?';
    row.appendChild(aiInput);
    var send = el('button', 'dp-ai-send', row);
    send.textContent = 'Ask';

    document.body.appendChild(fab);
    document.body.appendChild(panel);
  }

  function togglePanel() {
    panel.classList.toggle('dp-hidden');
    fab.classList.toggle('dp-fab-open');
    if (!panel.classList.contains('dp-hidden')) aiInput.focus();
  }

  function bubble(cls, html) {
    var b = el('div', 'dp-ai-bubble ' + cls, msgs);
    if (html) b.innerHTML = html;
    msgs.scrollTop = msgs.scrollHeight;
    return b;
  }

  function ask() {
    var q = aiInput.value.trim();
    if (!q) return;
    aiInput.value = '';
    bubble('dp-ai-user', mdLite(q));
    var thinking = bubble('dp-ai-bot', '<span class="dp-ai-dim">Searching the docs…</span>');

    if (aiConfig.endpoint) {
      fetch(aiConfig.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q })
      }).then(function (r) {
        if (!r.ok) throw new Error('endpoint ' + r.status);
        return r.json();
      }).then(function (data) {
        thinking.innerHTML = mdLite(data.answer || '(empty response)');
        msgs.scrollTop = msgs.scrollHeight;
      }).catch(function () {
        retrievalAnswer(q, thinking);
      });
    } else {
      retrievalAnswer(q, thinking);
    }
  }

  function retrievalAnswer(q, target) {
    getIndex().then(function (pages) {
      var hits = search(q, pages).slice(0, 3);
      if (!hits.length) {
        target.innerHTML = 'I couldn’t find anything about that in the docs. Try the <a href="' + BASE + '" data-dp-search="1">full page list</a>, or rephrase with a keyword like “freight”, “webhook”, or “sandbox”.';
        msgs.scrollTop = msgs.scrollHeight;
        return;
      }
      var html = 'Here’s what the documentation says — best matches first:';
      hits.forEach(function (r) {
        var url = r.page.u + (r.sec.i ? '#' + r.sec.i : '');
        html += '<div class="dp-ai-card"><a href="' + url + '"><span class="dp-ai-card-t">' +
          r.page.t + (r.sec.h && r.sec.h !== r.page.t ? ' › ' + r.sec.h : '') +
          '</span><span class="dp-ai-card-s">' + snippet(r.sec.b || r.sec.h, tokens(q)) + '</span></a></div>';
      });
      target.innerHTML = html;
      msgs.scrollTop = msgs.scrollHeight;
    });
  }

  /* ---------- global event forwarding ----------
   * Per-element events proved unreliable on the deployed host, so forward
   * input/keyup from the document root into the widget. */
  document.addEventListener('input', function (e) {
    if (modal && !modal.classList.contains('dp-hidden') && e.target === inputEl) runSearch();
  }, true);

  /* All clicks are delegated at the document root: on the deployed host,
   * per-element event listeners proved unreliable, while document-level
   * ones fire consistently. */
  function delegatedClick(e) {
    var t = e.target;
    if (!(t && t.closest)) return;
    if (t.closest('.dp-fab')) { togglePanel(); return; }
    if (t.closest('.dp-ai-close')) { togglePanel(); return; }
    if (t.closest('.dp-ai-send')) { ask(); return; }
    var item = t.closest('.dp-item');
    if (item) {
      e.preventDefault();
      go(parseInt(item.getAttribute('data-dp-idx'), 10));
      return;
    }
    if (e.type === 'mousedown' && t === modal) close();
  }
  document.addEventListener('click', delegatedClick, true);
  document.addEventListener('mousedown', delegatedClick, true);

  /* ---------- boot ---------- */
  function boot() {
    loadCss();
    buildAssistant();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
