(() => {
  'use strict';

  const PLUGIN_ID = 'cardmirror-keyword-finder';
  const STATE_KEY = 'keywordFinderState';
  const COMMENT_PREFIX = 'Keyword found: ';
  const CHANNEL_NAME = 'cardmirror-keyword-finder-state-v2';

  let pluginApi = null;
  let lastFocusedRoot = null;
  let mounted = false;
  let stateLoaded = false;
  let state = { keywords: [], caseInsensitive: true, wholeWord: true };
  let channel = null;

  function toast(message) {
    try { pluginApi?.showToast?.(String(message)); } catch (_) {}
    try { window.__cardMirrorRoundReportToast?.(String(message)); } catch (_) {}
  }

  function escapeRegex(v) {
    return String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function normalizeState(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return {
      keywords: [...new Set((Array.isArray(r.keywords) ? r.keywords : [])
        .map(x => String(x).trim()).filter(Boolean))],
      caseInsensitive: r.caseInsensitive !== false,
      wholeWord: r.wholeWord !== false,
    };
  }

  function stateUrl() {
    return new URL('./cardmirror-features/keyword-finder/keyword-state.json', window.location.href);
  }

  function fileUrlToPath(url) {
    let p = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return p;
  }

  async function loadPersistentState() {
    if (stateLoaded) return state;
    stateLoaded = true;

    // First choice: the hidden state file installed inside CardMirror.
    // This is shared by every CardMirror document window and survives restart.
    try {
      const res = await fetch(stateUrl().href + '?t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) {
        const parsed = await res.json();
        state = normalizeState(parsed);
        broadcastState();
        return state;
      }
    } catch (_) {}

    // Migration/fallback from earlier Keyword Finder builds.
    try {
      const raw = JSON.parse(localStorage.getItem('plugin:' + PLUGIN_ID) || 'null');
      if (raw && typeof raw === 'object') {
        const candidate = raw[STATE_KEY] && typeof raw[STATE_KEY] === 'object'
          ? raw[STATE_KEY] : raw;
        state = normalizeState(candidate);
        if (state.keywords.length) await persistState();
      }
    } catch (_) {}
    broadcastState();
    return state;
  }

  async function persistState() {
    state = normalizeState(state);

    // Keep a renderer-local fallback too.
    try {
      localStorage.setItem('plugin:' + PLUGIN_ID, JSON.stringify({ [STATE_KEY]: state }));
    } catch (_) {}

    // Desktop builds expose writeFileAtPath. Since the patcher places the
    // plugin beside this hidden JSON file, we can persist without asking the
    // user to manage an external keyword file.
    try {
      const api = window.electronAPI;
      if (api?.writeFileAtPath) {
        const path = fileUrlToPath(stateUrl());
        const bytes = new TextEncoder().encode(JSON.stringify(state, null, 2));
        await api.writeFileAtPath(path, bytes);
      }
    } catch (err) {
      console.warn('[Keyword Finder] persistent state write failed:', err);
    }
    broadcastState();
  }

  function keywords() {
    return state.keywords.slice();
  }

  function setupChannel() {
    try {
      channel = typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(CHANNEL_NAME) : null;
      if (!channel) return;
      channel.onmessage = async (e) => {
        const msg = e.data || {};
        if (msg.type === 'state') {
          state = normalizeState(msg.state);
          stateLoaded = true;
          refreshKeywordCount();
        } else if (msg.type === 'request-state') {
          if (stateLoaded) broadcastState();
        }
      };
      channel.postMessage({ type: 'request-state' });
    } catch (_) { channel = null; }
  }

  function broadcastState() {
    try { channel?.postMessage({ type: 'state', state }); } catch (_) {}
  }

  function activeRoot() {
    if (lastFocusedRoot?.isConnected) return lastFocusedRoot;
    return [...document.querySelectorAll('.ProseMirror')][0] || null;
  }

  function collectMatches(root, keyword, wholeWord, caseInsensitive) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const flags = caseInsensitive ? 'gi' : 'g';
    const pattern = wholeWord
      ? `(?<![\\p{L}\\p{N}_])${escapeRegex(keyword)}(?![\\p{L}\\p{N}_])`
      : escapeRegex(keyword);
    let rx;
    try { rx = new RegExp(pattern, flags + 'u'); }
    catch (_) { rx = new RegExp(escapeRegex(keyword), flags); }

    let node;
    while ((node = walker.nextNode())) {
      // Don't rescan text that is already a native CardMirror comment range.
      if (node.parentElement?.closest?.('.pmd-comment-range')) continue;
      const text = node.nodeValue || '';
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(text))) {
        out.push({ node, from: m.index, to: m.index + m[0].length, keyword });
        if (!m[0].length) rx.lastIndex++;
      }
    }
    return out;
  }

  async function selectTextMatch(match) {
    try {
      const root = match.node.parentElement?.closest('.ProseMirror');
      if (!root) return false;

      // Focus FIRST. The previous build focused after constructing the DOM
      // selection, which can collapse it before ProseMirror sees it.
      try { root.focus({ preventScroll: true }); } catch (_) { root.focus(); }

      const sel = window.getSelection?.();
      if (!sel) return false;
      const range = document.createRange();
      range.setStart(match.node, match.from);
      range.setEnd(match.node, match.to);
      sel.removeAllRanges();
      sel.addRange(range);

      // ProseMirror listens to selectionchange and mirrors the DOM selection
      // into EditorState. Give that observer two frames before invoking the
      // native Add Comment command.
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return !sel.isCollapsed;
    } catch (_) {
      return false;
    }
  }

  async function fillNewComment(text) {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const inputs = [...document.querySelectorAll('textarea.pmd-comment-reply-input')];
      const ta = inputs.find(x => x.offsetParent !== null) || inputs[inputs.length - 1];
      if (!ta) continue;
      ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const form = ta.closest('form');
      if (form) {
        form.requestSubmit();
        return true;
      }
    }
    return false;
  }

  async function addNativeComment(text) {
    // This is CardMirror beta.30's actual native Add Comment ribbon button.
    const btn = document.getElementById('comments-add-btn');
    if (!btn) return false;
    btn.click();
    return await fillNewComment(text);
  }

  async function scanDocument() {
    await loadPersistentState();
    const root = activeRoot();
    if (!root) { toast('Open a document before scanning for keywords.'); return; }
    const list = keywords();
    if (!list.length) { toast('No keywords are configured.'); return; }

    const detected = [];
    for (const keyword of list) {
      for (const m of collectMatches(root, keyword, state.wholeWord, state.caseInsensitive)) {
        detected.push(m);
      }
    }

    // Document-order index for stable reverse processing.
    const order = new Map();
    let oi = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) order.set(n, oi++);
    detected.sort((a,b) => (order.get(b.node)-order.get(a.node)) || (b.from-a.from));

    let commented = 0;
    let failed = 0;

    for (const match of detected) {
      // A prior comment can rebuild this text node. If it was detached, find
      // the next current occurrence of this keyword instead of using a stale
      // node reference.
      let current = match;
      if (!current.node.isConnected) {
        const refreshed = collectMatches(root, match.keyword, state.wholeWord, state.caseInsensitive);
        current = refreshed[refreshed.length - 1];
        if (!current) continue;
      }
      if (!(await selectTextMatch(current))) { failed++; continue; }
      if (await addNativeComment(COMMENT_PREFIX + match.keyword)) commented++;
      else failed++;
      await new Promise(r => setTimeout(r, 12));
    }

    const unique = [...new Set(detected.map(x => x.keyword.toLocaleLowerCase()))].length;
    showScanResult(detected.length, unique, commented, failed);
  }

  function isKeywordCommentCard(card) {
    // Expanded CardMirror threads render `.pmd-comment-body`, while collapsed
    // threads intentionally render only `.pmd-comment-preview-text`.
    const body = card.querySelector('.pmd-comment-body');
    const preview = card.querySelector('.pmd-comment-preview-text');
    const text = String((body || preview)?.textContent || '').trimStart();
    return text.startsWith(COMMENT_PREFIX);
  }

  async function deleteKeywordComments() {
    // Fast purge. CardMirror expands a clicked comment synchronously, so we
    // can collect every matching thread ID up front and invoke the native
    // delete control without waiting animation frames between threads.
    const toggle = document.getElementById('comments-toggle-btn');

    // The comment cards must be rendered so we can read collapsed preview
    // text. Opening the native comments column renders them synchronously.
    if (toggle && toggle.getAttribute('aria-pressed') !== 'true') {
      toggle.click();
    }

    const threadIds = [...document.querySelectorAll('article.pmd-comment-thread[data-thread-id]')]
      .filter(isKeywordCommentCard)
      .map(card => card.getAttribute('data-thread-id'))
      .filter(Boolean);

    if (!threadIds.length) {
      toast('No Keyword Finder comments were found in this document.');
      return;
    }

    let deleted = 0;

    for (const threadId of threadIds) {
      let card = document.querySelector(
        `article.pmd-comment-thread[data-thread-id="${CSS.escape(threadId)}"]`
      );
      if (!card) continue;

      // Collapsed cards intentionally have no Delete button. Clicking the card
      // calls CardMirror's setActiveThread(..., 'click'), whose render path is
      // synchronous, so the native Delete control is available immediately.
      let del = card.querySelector('button.pmd-comment-delete.pmd-card-head-delete');
      if (!del) {
        card.click();
        card = document.querySelector(
          `article.pmd-comment-thread[data-thread-id="${CSS.escape(threadId)}"]`
        );
        del = card?.querySelector('button.pmd-comment-delete.pmd-card-head-delete') || null;
      }

      if (!del) {
        console.warn('[Keyword Finder] Could not expose delete control for thread', threadId);
        continue;
      }

      // CardMirror's own handler strips the comment_range mark and deletes the
      // thread from comments plugin state in one native transaction.
      del.click();
      deleted++;
    }

    // The final native deletion schedules CardMirror's normal debounced column
    // refresh. Force one immediate native re-render by toggling the column off
    // and back on, preserving the user's visible-comments state.
    if (toggle && toggle.getAttribute('aria-pressed') === 'true') {
      toggle.click();
      toggle.click();
    }

    toast(`Deleted ${deleted} Keyword Finder comment${deleted===1?'':'s'}.`);
  }

  function themePalette() {
    const cs = getComputedStyle(document.body);
    const bg = cs.backgroundColor || 'rgb(255,255,255)';
    const nums = bg.match(/[\d.]+/g)?.map(Number) || [255,255,255];
    const lum = 0.2126*(nums[0]||0)+0.7152*(nums[1]||0)+0.0722*(nums[2]||0);
    const dark = lum < 140;
    return dark
      ? { bg:'#202124', fg:'#f5f5f5', input:'#292a2d', border:'#5f6368', muted:'#bdc1c6' }
      : { bg:'#ffffff', fg:'#111111', input:'#ffffff', border:'#b8b8b8', muted:'#666666' };
  }

  function applyDialogTheme(dialog) {
    const p = themePalette();
    dialog.style.setProperty('--kf-bg', p.bg);
    dialog.style.setProperty('--kf-fg', p.fg);
    dialog.style.setProperty('--kf-input', p.input);
    dialog.style.setProperty('--kf-border', p.border);
    dialog.style.setProperty('--kf-muted', p.muted);
  }

  function showScanResult(totalDetected, uniqueDetected, commented, failed) {
    const old = document.querySelector('.kf-overlay'); old?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'kf-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'kf-dialog kf-result';
    dialog.innerHTML = `
      <div class="kf-header"><strong>Keyword Finder</strong><button class="kf-x" type="button">×</button></div>
      <div class="kf-result-count"><strong>${totalDetected}</strong> keyword occurrence${totalDetected===1?'':'s'} detected.</div>
      <div class="kf-result-sub">${uniqueDetected} unique keyword${uniqueDetected===1?'':'s'} matched.</div>
      <div class="kf-result-sub">${commented} native CardMirror comment${commented===1?'':'s'} added.</div>
      ${failed ? `<div class="kf-warning">${failed} detected occurrence${failed===1?'':'s'} could not be commented.</div>` : ''}
      <button class="kf-ok" type="button">OK</button>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    applyDialogTheme(dialog);
    const close=()=>overlay.remove();
    dialog.querySelector('.kf-x').addEventListener('click',close);
    dialog.querySelector('.kf-ok').addEventListener('click',close);
  }

  async function showMainModal() {
    await loadPersistentState();
    const old = document.querySelector('.kf-overlay'); old?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'kf-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'kf-dialog';
    dialog.innerHTML = `
      <div class="kf-header"><strong>Keyword Finder</strong><button class="kf-x" type="button">×</button></div>
      <div class="kf-info"><span id="kf-count">${keywords().length}</span> keywords stored in CardMirror.</div>
      <label class="kf-check"><input id="kf-case" type="checkbox" ${state.caseInsensitive?'checked':''}> Case insensitive</label>
      <label class="kf-check"><input id="kf-whole" type="checkbox" ${state.wholeWord?'checked':''}> Whole word</label>
      <div class="kf-label">Keywords</div>
      <textarea id="kf-keywords" spellcheck="false">${escapeHtml(keywords().join('\n'))}</textarea>
      <div class="kf-help">One keyword or phrase per line. This list is saved inside the CardMirror installation.</div>
      <div class="kf-actions">
        <button id="kf-export" type="button">Export</button>
        <button id="kf-import" type="button">Import</button>
        <button id="kf-scan" class="kf-primary" type="button">Scan Document</button>
      </div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    applyDialogTheme(dialog);

    const ta=dialog.querySelector('#kf-keywords');
    const capture=async()=>{
      state = normalizeState({
        keywords: ta.value.split(/\r?\n/),
        caseInsensitive: dialog.querySelector('#kf-case').checked,
        wholeWord: dialog.querySelector('#kf-whole').checked,
      });
      dialog.querySelector('#kf-count').textContent=String(state.keywords.length);
      await persistState();
    };
    const close=()=>overlay.remove();
    dialog.querySelector('.kf-x').addEventListener('click', async()=>{ await capture(); close(); });
    dialog.querySelector('#kf-scan').addEventListener('click', async()=>{ await capture(); close(); await scanDocument(); });
    dialog.querySelector('#kf-export').addEventListener('click', async()=>{ await capture(); exportKeywords(); });
    dialog.querySelector('#kf-import').addEventListener('click', ()=>importKeywords(ta, capture));
  }

  function exportKeywords() {
    const blob=new Blob([keywords().join('\n')+'\n'],{type:'text/plain;charset=utf-8'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='debate_words.txt';
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }

  function importKeywords(textarea, save) {
    const input=document.createElement('input');
    input.type='file'; input.accept='.txt,text/plain';
    input.addEventListener('change', async()=>{
      const file=input.files?.[0]; if(!file)return;
      textarea.value=await file.text();
      await save();
      toast(`${state.keywords.length} keywords imported.`);
    });
    input.click();
  }

  function refreshKeywordCount() {
    const el=document.getElementById('kf-count');
    if(el) el.textContent=String(keywords().length);
  }

  function ensureStyles() {
    if (document.getElementById('cardmirror-keyword-finder-style')) return;
    const style=document.createElement('style');
    style.id='cardmirror-keyword-finder-style';
    style.textContent=`
      #cardmirror-keyword-finder-panel{display:flex;flex-direction:column;gap:4px;align-items:stretch;justify-content:center;margin-left:8px;padding-left:10px;padding-right:4px;border-left:1px solid var(--pmd-c-border,#777);min-width:150px;box-sizing:border-box}
      #cardmirror-keyword-finder-panel .kf-ribbon-btn{font-weight:600;min-width:138px;width:138px;white-space:nowrap;box-sizing:border-box;line-height:1.15;padding-left:10px;padding-right:10px}
      .kf-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.36);display:flex;align-items:center;justify-content:center}
      .kf-dialog{width:min(620px,calc(100vw - 32px));max-height:90vh;overflow:auto;background:var(--kf-bg);color:var(--kf-fg);border:1px solid var(--kf-border);border-radius:10px;box-shadow:0 16px 50px rgba(0,0,0,.28);padding:16px;font:14px system-ui,sans-serif}
      .kf-header{display:flex;justify-content:space-between;align-items:center;font-size:18px;margin-bottom:12px}.kf-x{border:0;background:transparent;color:inherit;font-size:24px;cursor:pointer}
      .kf-info,.kf-help,.kf-result-sub{font-size:12px;color:var(--kf-muted);margin-bottom:10px}.kf-label{font-size:12px;font-weight:700;margin:12px 0 5px}.kf-check{display:block;margin:8px 0}
      #kf-keywords{box-sizing:border-box;width:100%;height:220px;resize:vertical;padding:9px;border:1px solid var(--kf-border);border-radius:6px;background:var(--kf-input);color:var(--kf-fg);font:13px ui-monospace,SFMono-Regular,Consolas,monospace}
      .kf-actions{display:flex;justify-content:flex-end;gap:7px;flex-wrap:wrap;margin-top:14px}.kf-actions button,.kf-ok{padding:8px 12px;border:1px solid var(--kf-border);border-radius:6px;background:var(--kf-input);color:var(--kf-fg);cursor:pointer}.kf-primary,.kf-ok{font-weight:700}.kf-result{text-align:center;max-width:440px}.kf-result-count{font-size:17px;margin:14px 0 5px}.kf-warning{margin-top:10px;font-size:12px;color:var(--kf-fg)}.kf-result .kf-ok{margin-top:16px;min-width:80px}
    `;
    document.head.appendChild(style);
  }

  function mountUi() {
    ensureStyles();
    if (document.getElementById('cardmirror-keyword-finder-panel')) {
      mounted=true; return true;
    }
    const custom=document.getElementById('custom-ribbon-panel');
    const parent=custom?.parentElement;
    if(!custom || !parent) return false;

    const wrap=document.createElement('div');
    wrap.id='cardmirror-keyword-finder-panel';
    wrap.className='ribbon-doc-ops-panel';
    wrap.setAttribute('role','group');
    wrap.setAttribute('aria-label','Keyword Finder');

    const scan=document.createElement('button');
    scan.type='button'; scan.className='ribbon-doc-ops-btn kf-ribbon-btn';
    scan.textContent='Keyword Finder';
    scan.title='Edit keywords and scan the current document';
    scan.addEventListener('mousedown',e=>e.preventDefault());
    scan.addEventListener('click',()=>showMainModal());

    const del=document.createElement('button');
    del.type='button'; del.className='ribbon-doc-ops-btn kf-ribbon-btn';
    del.textContent='Delete Keywords';
    del.title='Delete comments created by Keyword Finder';
    del.addEventListener('mousedown',e=>e.preventDefault());
    del.addEventListener('click',()=>deleteKeywordComments());

    wrap.append(scan,del);
    custom.insertAdjacentElement('afterend',wrap);
    mounted=true;
    return true;
  }

  function maintainUi() {
    if (!document.getElementById('cardmirror-keyword-finder-panel')) mounted=false;
    if (!mounted) mountUi();
  }

  const def={
    id:PLUGIN_ID,
    name:'Keyword Finder',
    apiVersion:1,
    commands:[
      {id:PLUGIN_ID+'.scan',label:'Keyword Finder: Scan Document',keywords:['keyword','finder','scan'],defaultKey:null,run:api=>{pluginApi=api;showMainModal();}},
      {id:PLUGIN_ID+'.deleteComments',label:'Keyword Finder: Delete Keyword Comments',keywords:['keyword','comments','delete'],defaultKey:null,run:api=>{pluginApi=api;deleteKeywordComments();}},
    ],
    settings:[]
  };

  try { window.__registerCardMirrorPlugin?.(def); } catch(e) { console.error('[Keyword Finder] registration failed',e); }

  document.addEventListener('focusin',e=>{const r=e.target?.closest?.('.ProseMirror');if(r)lastFocusedRoot=r;},true);
  document.addEventListener('mousedown',e=>{const r=e.target?.closest?.('.ProseMirror');if(r)lastFocusedRoot=r;},true);

  setupChannel();
  void loadPersistentState();

  // CardMirror rebuilds pieces of the ribbon when side panels open/close.
  // Observe the whole page and remount whenever our section is removed.
  const observer=new MutationObserver(()=>maintainUi());
  observer.observe(document.documentElement,{childList:true,subtree:true});
  setInterval(maintainUi,1000);
  maintainUi();
})();