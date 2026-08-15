(() => {
  'use strict';

  const PLUGIN_ID = 'cardmirror-round-report';
  const STORAGE_KEY = 'plugin:' + PLUGIN_ID;
  const SPEECHES = ['1AC','1NC','2AC','2NC','1NR','1AR','2NR','2AR'];
  const SPEECH_IDS = Object.fromEntries(SPEECHES.map(s => [s, 'rr-' + s.toLowerCase()]));
  const RR_CHANNEL_NAME = 'cardmirror-round-report-v2';
  const RR_INSTANCE_ID = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'rr-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  let rrChannel = null;
  let state = { assignments: {}, form: {}, updatedAt: 0 };
  let stateInitialized = false;
  let lastFocusedRoot = null;
  let pluginApi = null;
  let uiMounted = false;

  function safeString(v) { return typeof v === 'string' ? v : ''; }

  function normalizeState(raw) {
    if (!raw || typeof raw !== 'object') return { assignments: {}, form: {}, updatedAt: 0 };
    return {
      assignments: raw.assignments && typeof raw.assignments === 'object' ? raw.assignments : {},
      form: raw.form && typeof raw.form === 'object' ? raw.form : {},
      updatedAt: Number(raw.updatedAt) || 0
    };
  }

  function loadState() {
    let best = null;
    try {
      if (pluginApi && pluginApi.storage) {
        const saved = normalizeState(pluginApi.storage.get('roundReportState'));
        if (saved.updatedAt || Object.keys(saved.assignments).length || Object.keys(saved.form).length) best = saved;
      }
    } catch (_) {}
    try {
      const saved = normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
      if (!best || saved.updatedAt > best.updatedAt ||
          (saved.updatedAt === best.updatedAt &&
           Object.keys(saved.assignments).length > Object.keys(best.assignments).length)) {
        best = saved;
      }
    } catch (_) {}
    return best || { assignments: {}, form: {}, updatedAt: 0 };
  }

  function persistState(shouldBroadcast) {
    try { if (pluginApi && pluginApi.storage) pluginApi.storage.set('roundReportState', state); } catch (_) {}
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
    if (shouldBroadcast && rrChannel) {
      try {
        rrChannel.postMessage({ type: 'state', sender: RR_INSTANCE_ID, state });
      } catch (_) {}
    }
  }

  function saveState() {
    state.updatedAt = Date.now();
    persistState(true);
  }

  // Do not re-read renderer-local storage on every refresh. In the desktop
  // build, a newly spawned CardMirror window can initialize before it has
  // received the existing assignment state. Re-reading an empty store was the
  // mechanism that made the ribbon appear to "forget" earlier assignments.
  function refreshState() {
    if (!stateInitialized) {
      state = loadState();
      stateInitialized = true;
    }
  }

  function setupCrossWindowState() {
    try {
      rrChannel = new BroadcastChannel(RR_CHANNEL_NAME);
      rrChannel.addEventListener('message', (event) => {
        const msg = event && event.data;
        if (!msg || msg.sender === RR_INSTANCE_ID) return;

        if (msg.type === 'request-state') {
          try {
            rrChannel.postMessage({ type: 'state', sender: RR_INSTANCE_ID, state });
          } catch (_) {}
          return;
        }

        if (msg.type === 'state') {
          const remote = normalizeState(msg.state);
          if (remote.updatedAt >= state.updatedAt ||
              (!Object.keys(state.assignments).length && Object.keys(remote.assignments).length)) {
            state = remote;
            stateInitialized = true;
            // Persist without rebroadcasting, otherwise every window would
            // answer the same state message forever.
            persistState(false);
            refreshButtons();
          }
        }
      });
      // A newly opened document window explicitly asks existing windows for
      // their current assignments.
      rrChannel.postMessage({ type: 'request-state', sender: RR_INSTANCE_ID });
    } catch (_) {
      rrChannel = null;
    }

    // Fallback for environments where BroadcastChannel is unavailable.
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        const remote = normalizeState(JSON.parse(event.newValue));
        if (remote.updatedAt >= state.updatedAt) {
          state = remote;
          stateInitialized = true;
          refreshButtons();
        }
      } catch (_) {}
    });
  }

  function activeEditorRoot() {
    const a = document.activeElement;
    if (a && a.closest) {
      const e = a.closest('.ProseMirror');
      if (e) return e;
    }
    return document.querySelector('.ProseMirror.ProseMirror-focused') || lastFocusedRoot || null;
  }

  function getActiveRoot() {
    const root = activeEditorRoot();
    if (root && root.isConnected) { lastFocusedRoot = root; return root; }
    if (lastFocusedRoot && lastFocusedRoot.isConnected) return lastFocusedRoot;
    const roots = Array.from(document.querySelectorAll('.ProseMirror'));
    if (roots.length === 1) { lastFocusedRoot = roots[0]; return roots[0]; }
    return roots[0] || null;
  }

  function docKey(root, api) {
    try {
      const info = api && api.docInfo ? api.docInfo() : null;
      if (info && info.docId) return 'doc:' + info.docId;
    } catch (_) {}
    return null;
  }

  function docTitle(root, api) {
    try { const info = api && api.docInfo ? api.docInfo() : null; if (info && info.docTitle) return info.docTitle; } catch (_) {}
    const chip = document.querySelector('#doc-name-chip, .doc-name-chip');
    return safeString((chip && chip.textContent) || '').trim() || 'Untitled';
  }

  function snapshot(root, api) {
    if (!root || !root.isConnected) return null;
    const desc = root.pmViewDesc;
    const node = desc && desc.node;
    if (!node || typeof node.toJSON !== 'function') return null;
    const key = docKey(root, api);
    const html = root.innerHTML;
    const json = node.toJSON();
    return { key, docId: (api && api.docInfo && api.docInfo() || {}).docId || null, title: docTitle(root, api), html, json, capturedAt: Date.now() };
  }

  function toast(message) {
    try {
      if (window.__registerCardMirrorPlugin && window.__cardMirrorRoundReportToast) {
        window.__cardMirrorRoundReportToast(String(message));
        return;
      }
    } catch (_) {}
    let el = document.getElementById('rr-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rr-toast';
      el.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:99999;padding:10px 14px;border-radius:8px;background:#222;color:#fff;font:14px system-ui;box-shadow:0 4px 18px rgba(0,0,0,.25);opacity:0;transition:opacity .15s;pointer-events:none';
      document.body.appendChild(el);
    }
    el.textContent = String(message); el.style.opacity = '1';
    clearTimeout(el.__rrTimer); el.__rrTimer = setTimeout(() => { el.style.opacity = '0'; }, 1800);
  }

  function assignedSpeechForKey(key) {
    refreshState();
    for (const speech of SPEECHES) if (state.assignments[speech] && state.assignments[speech].key === key) return speech;
    return null;
  }

  function currentDocKey() {
    try {
      const info = pluginApi && pluginApi.docInfo ? pluginApi.docInfo() : null;
      return info && info.docId ? 'doc:' + info.docId : null;
    } catch (_) { return null; }
  }

  function refreshButtons() {
    refreshState();
    const keys = currentDocKeys();
    for (const speech of SPEECHES) {
      const b = document.getElementById(SPEECH_IDS[speech]);
      if (!b) continue;
      const a = state.assignments[speech];
      const selected = !!a && (
        keys.includes(a.key) ||
        (!!a.provisionalKey && keys.includes(a.provisionalKey))
      );
      b.classList.toggle('rr-selected', selected);
      b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }
  }

  function provisionalDocKey(root) {
    // Before the first save, beta.30 may not have populated docInfo() yet.
    // Give the live document a stable renderer-local key based on its title,
    // while keeping the real CardMirror docId once it becomes available.
    const title = docTitle(root, pluginApi);
    return 'title:' + title.trim().toLowerCase().replace(/\\s+/g, ' ');
  }

  function currentDocKeys() {
    const keys = [];
    try {
      const info = pluginApi && pluginApi.docInfo ? pluginApi.docInfo() : null;
      if (info && info.docId) keys.push('doc:' + info.docId);
    } catch (_) {}
    const root = getActiveRoot();
    if (root) keys.push(provisionalDocKey(root));
    return [...new Set(keys)];
  }

  function captureCurrentSnapshot(api) {
    pluginApi = api || pluginApi;
    const root = getActiveRoot();
    if (!root) { toast('Could not find the current editor.'); return null; }

    let info = null;
    try { info = pluginApi && pluginApi.docInfo ? pluginApi.docInfo() : null; } catch (_) {}

    // docInfo() can briefly be unavailable when a newly opened document has
    // not finished initializing. The editor itself is still usable, so do not
    // block speech assignment on docInfo().
    const snap = snapshot(root, pluginApi);
    if (!snap) { toast('Could not read the current CardMirror document.'); return null; }

    const realKey = info && info.docId ? 'doc:' + info.docId : null;
    snap.key = realKey || provisionalDocKey(root);
    snap.docId = info && info.docId ? info.docId : null;
    snap.title = (info && info.docTitle) || snap.title || 'Untitled';
    snap.provisionalKey = provisionalDocKey(root);
    return snap;
  }

  function assignSpeech(speech, api) {
    const snap = captureCurrentSnapshot(api);
    if (!snap) return;
    refreshState();
    const current = state.assignments[speech];
    if (current && current.key === snap.key) {
      delete state.assignments[speech];
      saveState(); refreshButtons(); toast(speech + ' assignment cleared.');
      return;
    }
    for (const other of SPEECHES) {
      if (other !== speech && state.assignments[other] && state.assignments[other].key === snap.key) {
        delete state.assignments[other];
      }
    }
    state.assignments[speech] = snap;
    saveState();
    refreshButtons();
    toast((snap.title || 'Document') + ' assigned to ' + speech + '.');
  }

  function escapeHtml(s) {
    return safeString(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function escXml(s) {
    return safeString(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  }
  function escapeFilePart(s) {
    return safeString(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g,'-').replace(/\s+/g,' ').trim();
  }
  function normalizedRound(s) { return safeString(s).trim().replace(/^round\s*/i,'').trim() || '1'; }

  function showModal() {
    refreshState();
    const overlay = document.createElement('div');
    overlay.className = 'rr-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'rr-dialog';
    dialog.innerHTML = '<div class="rr-header"><strong>Create Round Report</strong><button type="button" class="rr-x">×</button></div>' +
      '<div class="rr-fields"></div><div class="rr-actions"><button type="button" class="rr-cancel">Cancel</button><button type="button" class="rr-ok">OK</button></div>';
    overlay.appendChild(dialog); document.body.appendChild(overlay);
    const bodyStyle = getComputedStyle(document.body);
    const bodyBg = bodyStyle.backgroundColor || '';
    const bodyFg = bodyStyle.color || '';
    const rgb = bodyBg.match(/\d+/g);
    const luminance = rgb && rgb.length >= 3 ? (0.2126*Number(rgb[0]) + 0.7152*Number(rgb[1]) + 0.0722*Number(rgb[2])) : 255;
    const dark = luminance < 140;
    dialog.style.color = dark ? '#fff' : '#111';
    dialog.style.background = dark ? '#202124' : '#fff';
    dialog.style.borderColor = dark ? '#555' : '#bbb';
    const fields = [
      ['tournamentName','Tournament name','e.g. Harvard'],
      ['roundNumber','Round number','e.g. 4'],
      ['judgeName','Judge name','e.g. Jane Smith'],
      ['affTeam','Affirmative team','e.g. Georgetown BM'],
      ['negTeam','Negative team','e.g. Harvard GS'],
      ['affirmative','Affirmative name','e.g. Single Payer'],
      ['negOff1NC','1NC positions','e.g. Politics DA + States CP'],
      ['negOff2NR','2NR position(s)','e.g. Politics DA'],
    ];
    const values = Object.assign({}, state.form || {});
    // Optional Smart Doc / Round Context integration. Round Report remains
    // fully standalone when Smart Doc is not installed.
    try {
      const rc = window.__cardMirrorRoundContext?.get?.();
      if (rc && typeof rc === 'object') {
        if (rc.tournament) values.tournamentName = String(rc.tournament);
        if (rc.round) values.roundNumber = String(rc.round);
        if (rc.judge) values.judgeName = String(rc.judge);
        if (rc.yourTeam && rc.opponent && rc.side === 'aff') {
          values.affTeam = String(rc.yourTeam);
          values.negTeam = String(rc.opponent);
        } else if (rc.yourTeam && rc.opponent && rc.side === 'neg') {
          values.affTeam = String(rc.opponent);
          values.negTeam = String(rc.yourTeam);
        }
      }
    } catch (_) {}
    const map = {};
    const selectedPanel = document.createElement('div');
    selectedPanel.className = 'rr-selected-docs';
    selectedPanel.innerHTML = '<div class="rr-selected-title">Selected speech documents</div>';
    for (const speech of SPEECHES) {
      const a = state.assignments[speech];
      const row = document.createElement('div');
      row.className = 'rr-selected-row';
      const name = a ? (a.title || 'Untitled') : '—';
      row.innerHTML = '<strong>' + escapeHtml(speech) + '</strong><span>' + escapeHtml(name) + '</span>';
      selectedPanel.appendChild(row);
    }
    dialog.querySelector('.rr-fields').before(selectedPanel);
    const container = dialog.querySelector('.rr-fields');
    for (const [key,label,placeholder] of fields) {
      const labelEl = document.createElement('label'); labelEl.className='rr-field';
      labelEl.innerHTML='<span>'+escapeHtml(label)+'</span>';
      const input=document.createElement('input'); input.type='text'; input.placeholder=placeholder; input.value=safeString(values[key]); input.dataset.key=key;
      labelEl.appendChild(input); container.appendChild(labelEl); map[key]=input;
    }
    const cancel=dialog.querySelector('.rr-cancel'); const ok=dialog.querySelector('.rr-ok');
    const close=()=>overlay.remove();
    cancel.addEventListener('click',close); dialog.querySelector('.rr-x').addEventListener('click',close);
    overlay.addEventListener('mousedown',e=>{if(e.target===overlay)close();});
    ok.addEventListener('click',()=>{
      const data={}; let missing=[];
      for (const [key] of fields) { data[key]=map[key].value.trim(); if(!data[key]) missing.push(map[key].previousSibling.textContent); }
      if(missing.length){toast('Please fill in: '+missing.join(', ')); return;}
      state.form=data; saveState(); close(); void createReport(data);
    });
    map.tournamentName.focus();
  }

  function markWrap(text, marks) {
    let out = escapeHtml(text);
    for (const mark of (marks || [])) {
      const type = safeString(mark && mark.type).toLowerCase();
      if (type.includes('strong') || type === 'bold') out = '<strong>' + out + '</strong>';
      else if (type.includes('em') || type === 'italic') out = '<em>' + out + '</em>';
      else if (type.includes('underline')) out = '<u>' + out + '</u>';
      else if (type.includes('strike')) out = '<s>' + out + '</s>';
      else if (type === 'link' && mark.attrs && mark.attrs.href) {
        out = '<a href="' + escapeHtml(mark.attrs.href) + '">' + out + '</a>';
      }
    }
    return out;
  }

  // Render the ProseMirror JSON tree rather than relying only on the rendered
  // DOM. CardMirror uses custom node views for cards, and some of their body
  // content isn't represented in the simple HTML we were previously feeding
  // to the DOCX converter.
  function jsonNodeToHtml(node, depth=0) {
    if (!node) return '';
    if (node.type === 'text') return markWrap(node.text || '', node.marks);

    const children = (node.content || []).map(child => jsonNodeToHtml(child, depth + 1)).join('');
    const type = safeString(node.type).toLowerCase();

    if (type === 'hard_break' || type === 'hardbreak') return '<br>';
    if (type === 'image') {
      const src = node.attrs && (node.attrs.src || node.attrs.url);
      return src ? '<img src="' + escapeHtml(src) + '">' : '';
    }

    // CardMirror's semantic nodes.
    if (type === 'tag') return '<h4 class="pmd-tag">' + children + '</h4>';
    if (type === 'card') return '<div class="pmd-card">' + children + '</div>';
    if (type === 'card_body' || type === 'cardbody') return '<div class="pmd-card-body">' + children + '</div>';
    if (type === 'undertag') return '<div class="pmd-undertag">' + children + '</div>';
    if (type === 'cite_paragraph' || type === 'citeparagraph') return '<p class="pmd-cite-para">' + children + '</p>';
    if (type === 'analytic_unit' || type === 'analyticunit') return '<p class="pmd-analytic">' + children + '</p>';
    if (type === 'pocket') return '<h1 class="pmd-pocket">' + children + '</h1>';
    if (type === 'hat') return '<h2 class="pmd-hat">' + children + '</h2>';
    if (type === 'block') return '<h3 class="pmd-block">' + children + '</h3>';

    // Common ProseMirror block nodes.
    if (type === 'paragraph' || type === 'p') return '<p>' + children + '</p>';
    if (type === 'heading') {
      const level = Math.min(6, Math.max(1, Number(node.attrs && node.attrs.level) || 2));
      return '<h' + level + '>' + children + '</h' + level + '>';
    }
    if (type === 'bullet_list') return '<ul>' + children + '</ul>';
    if (type === 'ordered_list') return '<ol>' + children + '</ol>';
    if (type === 'list_item') return '<li>' + children + '</li>';
    if (type === 'blockquote') return '<blockquote>' + children + '</blockquote>';
    if (type === 'code_block') return '<pre>' + children + '</pre>';

    // Unknown containers are deliberately retained as divs so we never drop
    // a custom CardMirror node just because the plugin doesn't know its name.
    return children ? '<div data-pm-node="' + escapeHtml(node.type || 'unknown') + '">' + children + '</div>' : '';
  }

  function snapshotSpeechHtml(snapshot) {
    if (!snapshot) return '';
    if (snapshot.json) {
      const rendered = jsonNodeToHtml(snapshot.json);
      if (rendered.trim()) return rendered;
    }
    return safeString(snapshot.html);
  }

  function makeHtmlReport(data) {
    refreshState();
    const title = escapeHtml(data.tournamentName+' Round '+normalizedRound(data.roundNumber)+'---Aff '+data.affTeam+' vs. Neg '+data.negTeam);
    let body = '<h1 class="pmd-pocket">'+title+'</h1>';
    const tag = (label,value) => '<h4 class="pmd-tag"><strong>'+escapeHtml(label)+':</strong> '+escapeHtml(value)+'</h4>';
    body += tag('AFF',data.affTeam);
    body += tag('NEG',data.negTeam);
    body += tag('1AC',data.affirmative);
    body += tag('1NC',data.negOff1NC);
    body += tag('2NR',data.negOff2NR);
    body += tag('Reason for Decision '+data.judgeName,'');
    for (const speech of SPEECHES) {
      body += '<h1 class="pmd-pocket">'+speech+'</h1>';
      const a = state.assignments[speech];
      if (a) body += snapshotSpeechHtml(a);
    }
    return '<!doctype html><html><head><meta charset="utf-8"><style>'+REPORT_CSS+'</style></head><body>'+body+'</body></html>';
  }

  const REPORT_CSS = 'body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#111;margin:1in}h1.pmd-pocket{font-size:15pt;margin:12pt 0 7pt;padding:5pt 7pt;border:1.5pt solid #555;background:#f2f2f2;line-height:1.15}h4.pmd-tag{font-size:11pt;margin:2pt 0;line-height:1.15;color:#17365d}.pmd-card{margin:4pt 0}.pmd-card-body,.pmd-cite-para,.pmd-undertag,.pmd-analytic{margin:2pt 0}h2.pmd-hat{font-size:13pt;margin:9pt 0 5pt}h3.pmd-block{font-size:12pt;margin:7pt 0 4pt}h4.pmd-tag{font-weight:700}.pmd-cite{font-weight:700}.pmd-underline{text-decoration:underline}.pmd-emphasis{font-weight:700}.pmd-undertag-mark{font-style:italic}.pmd-analytic-mark{font-style:italic}.pmd-card img,.ProseMirror img{max-width:100%;height:auto}.pmd-highlight{background:#ff0}.pmd-shading{background:#eee}table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:3pt}';

  function crc32(bytes){ let c=0xffffffff; for(let i=0;i<bytes.length;i++){ c^=bytes[i]; for(let k=0;k<8;k++) c=(c>>>1)^((c&1)?0xedb88320:0); } return (~c)>>>0; }
  function zipStore(entries){
    const enc=new TextEncoder(); const locals=[]; const central=[]; let offset=0;
    for(const [name,data0] of entries){
      const nameB=enc.encode(name); const data=data0 instanceof Uint8Array?data0:enc.encode(data0); const crc=crc32(data);
      const h=new Uint8Array(30+nameB.length+data.length); const d=new DataView(h.buffer);
      d.setUint32(0,0x04034b50,true); d.setUint16(4,20,true); d.setUint16(6,0,true); d.setUint16(8,0,true); d.setUint16(10,0,true);
      d.setUint16(12,0,true); d.setUint32(14,crc,true); d.setUint32(18,data.length,true); d.setUint32(22,data.length,true); d.setUint16(26,nameB.length,true); d.setUint16(28,0,true); h.set(nameB,30); h.set(data,30+nameB.length);
      locals.push(h); const centralH=new Uint8Array(46+nameB.length); const c=new DataView(centralH.buffer);
      c.setUint32(0,0x02014b50,true); c.setUint16(4,20,true); c.setUint16(6,20,true); c.setUint16(8,0,true); c.setUint16(10,0,true); c.setUint16(12,0,true); c.setUint16(14,0,true); c.setUint32(16,crc,true); c.setUint32(20,data.length,true); c.setUint32(24,data.length,true); c.setUint16(28,nameB.length,true); c.setUint16(30,0,true); c.setUint16(32,0,true); c.setUint16(34,0,true); c.setUint16(36,0,true); c.setUint32(38,0,true); c.setUint32(42,offset,true); centralH.set(nameB,46); central.push(centralH); offset+=h.length;
    }
    const cdSize=central.reduce((n,x)=>n+x.length,0); const end=new Uint8Array(22); const e=new DataView(end.buffer); e.setUint32(0,0x06054b50,true); e.setUint16(4,0,true); e.setUint16(6,0,true); e.setUint16(8,entries.length,true); e.setUint16(10,entries.length,true); e.setUint32(12,cdSize,true); e.setUint32(16,offset,true); e.setUint16(20,0,true);
    const out=new Uint8Array(offset+cdSize+22); let p=0; for(const x of locals){out.set(x,p);p+=x.length} for(const x of central){out.set(x,p);p+=x.length} out.set(end,p); return out;
  }

  function wordRun(text, opts={}) {
    if (!text) return '';
    let rPr='';
    if (opts.bold) rPr += '<w:b/>';
    if (opts.italic) rPr += '<w:i/>';
    if (opts.underline) rPr += '<w:u w:val="single"/>';
    return '<w:r>'+(rPr?'<w:rPr>'+rPr+'</w:rPr>':'')+'<w:t xml:space="preserve">'+escXml(text)+'</w:t></w:r>';
  }

  function inlineRuns(node, opts={}) {
    if (node.nodeType === Node.TEXT_NODE) return wordRun(node.nodeValue || '', opts);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el=node; const tag=el.tagName.toLowerCase();
    const next={...opts};
    if (tag==='strong' || tag==='b') next.bold=true;
    if (tag==='em' || tag==='i') next.italic=true;
    if (tag==='u') next.underline=true;
    if (tag==='br') return '<w:br/>';
    return Array.from(el.childNodes).map(n=>inlineRuns(n,next)).join('');
  }

  function wordParagraph(el, style) {
    const runs=inlineRuns(el);
    const pPr=style?'<w:pPr><w:pStyle w:val="'+style+'"/></w:pPr>':'';
    return '<w:p>'+pPr+runs+'</w:p>';
  }

  // Build WordprocessingML directly from the captured ProseMirror JSON.
  // This avoids losing CardMirror's card_body paragraphs when an HTML
  // intermediate is parsed by the lightweight DOCX writer.
  function xmlEsc(v) {
    return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  }

  function markRunProps(marks) {
    const props=[];
    for(const mark of (marks || [])){
      const type=safeString(mark && mark.type).toLowerCase();
      const attrs=(mark && mark.attrs) || {};
      if(type==='bold') props.push('<w:b/>');
      else if(type==='bold_off') props.push('<w:b w:val="0"/>');
      else if(type==='italic') props.push('<w:i/><w:iCs/>');
      else if(type==='strikethrough' || type==='strike') props.push('<w:strike/>');
      else if(type==='underline_mark' || type==='underline_direct' || type==='underline') props.push('<w:u w:val="single"/>');
      else if(type==='superscript') props.push('<w:vertAlign w:val="superscript"/>');
      else if(type==='subscript') props.push('<w:vertAlign w:val="subscript"/>');
      else if(type==='cite_mark') props.push('<w:rStyle w:val="Style13ptBold"/>');
      else if(type==='emphasis_mark') props.push('<w:rStyle w:val="Emphasis"/>');
      else if(type==='undertag_mark') props.push('<w:rStyle w:val="UndertagChar"/>');
      else if(type==='analytic_mark') props.push('<w:rStyle w:val="AnalyticChar"/>');
      else if(type==='font_size'){
        const hp=Number(attrs.halfPoints ?? 22);
        if(Number.isFinite(hp) && hp>0) props.push('<w:sz w:val="'+Math.round(hp)+'"/><w:szCs w:val="'+Math.round(hp)+'"/>');
      } else if(type==='font_color'){
        const c=safeString(attrs.color || '000000').replace(/[^0-9a-f]/gi,'').slice(0,6);
        if(c.length===6 && c!=='000000') props.push('<w:color w:val="'+c+'"/>');
      } else if(type==='highlight'){
        const c=safeString(attrs.color || 'yellow');
        const allowed=new Set(['yellow','green','cyan','magenta','blue','red','darkBlue','darkCyan','darkGreen','darkMagenta','darkRed','darkYellow','darkGray','lightGray','black','none']);
        if(allowed.has(c) && c!=='none') props.push('<w:highlight w:val="'+c+'"/>');
      } else if(type==='shading'){
        const c=safeString(attrs.color || 'D2D2D2').replace(/[^0-9a-f]/gi,'').slice(0,6);
        if(c.length===6) props.push('<w:shd w:fill="'+c+'"/>');
      } else if(type==='font_family'){
        const n=safeString(attrs.name);
        if(n) props.push('<w:rFonts w:ascii="'+xmlEsc(n)+'" w:hAnsi="'+xmlEsc(n)+'" w:cs="'+xmlEsc(n)+'"/>');
      }
    }
    return props.length ? '<w:rPr>'+props.join('')+'</w:rPr>' : '';
  }

  function textRunXml(text, marks) {
    const value=safeString(text);
    if(!value) return '';
    const chunks=value.split('\n');
    let out='';
    chunks.forEach((chunk,i)=>{
      if(i>0) out+='<w:br/>';
      if(!chunk) return;
      out+='<w:r>'+markRunProps(marks)+'<w:t xml:space="preserve">'+xmlEsc(chunk)+'</w:t></w:r>';
    });
    return out;
  }

  function inlineXml(node) {
    if(!node) return '';
    if(node.type==='text') return textRunXml(node.text || '', node.marks);
    if(node.type==='hard_break' || node.type==='hardbreak') return '<w:r><w:br/></w:r>';
    if(node.type==='image'){
      // Preserve a readable placeholder rather than silently dropping an image.
      const alt=(node.attrs && node.attrs.alt) || '[image]';
      return textRunXml('['+alt+']', []);
    }
    return (node.content || []).map(inlineXml).join('');
  }

  let rrBookmarkCounter = 1;
  function paragraphXml(node, styleId) {
    const attrs=(node && node.attrs) || {};
    const pPr=[];
    if(styleId) pPr.push('<w:pStyle w:val="'+xmlEsc(styleId)+'"/>');
    const indent=Number(attrs.indent || 0);
    if(Number.isFinite(indent) && indent>0) pPr.push('<w:ind w:left="'+Math.round(indent)+'"/>');
    if(attrs.alignment) pPr.push('<w:jc w:val="'+xmlEsc(attrs.alignment)+'"/>');

    const structural = styleId === 'Heading1' || styleId === 'Heading2' ||
      styleId === 'Heading3' || styleId === 'Heading4' || styleId === 'Analytic';
    let bookmarkStart = '';
    let bookmarkEnd = '';
    if (structural) {
      const numericId = rrBookmarkCounter++;
      const rawName = safeString(attrs.id) || ('rr-' + styleId.toLowerCase() + '-' + numericId);
      const bookmarkName = ('pmd-heading-' + rawName).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 38);
      bookmarkStart = '<w:bookmarkStart w:id="'+numericId+'" w:name="'+xmlEsc(bookmarkName)+'"/>';
      bookmarkEnd = '<w:bookmarkEnd w:id="'+numericId+'"/>';
    }

    return '<w:p>'+(pPr.length?'<w:pPr>'+pPr.join('')+'</w:pPr>':'')+
      bookmarkStart+inlineXml(node)+bookmarkEnd+'</w:p>';
  }

  function jsonNodeToWordXml(node) {
    if(!node) return '';
    const type=safeString(node.type).toLowerCase();
    const children=node.content || [];

    if(type==='doc') return children.map(jsonNodeToWordXml).join('');
    if(type==='pocket') return paragraphXml(node,'Heading1');
    if(type==='hat') return paragraphXml(node,'Heading2');
    if(type==='block') return paragraphXml(node,'Heading3');
    if(type==='tag') {
      const p=paragraphXml(node,'Heading4');
      return p;
    }
    if(type==='analytic') return paragraphXml(node,'Analytic');
    if(type==='card_body') return paragraphXml(node,'Normal');
    if(type==='cite_paragraph') return paragraphXml(node,'Normal');
    if(type==='undertag') return paragraphXml(node,'Normal');
    if(type==='paragraph') return paragraphXml(node,'Normal');

    if(type==='card' || type==='analytic_unit' || type==='transclusion_ref' || type==='self_ref')
      return children.map(jsonNodeToWordXml).join('');

    if(type==='table'){
      const rows=children.map(row=>{
        const cells=(row.content || []).map(cell=>{
          const paras=(cell.content || []).map(p=>paragraphXml(p,'Normal')).join('');
          return '<w:tc>'+paras+'</w:tc>';
        }).join('');
        return '<w:tr>'+cells+'</w:tr>';
      }).join('');
      return '<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>'+rows+'</w:tbl>';
    }

    // Any unknown block is retained recursively.
    return children.map(jsonNodeToWordXml).join('');
  }

  function htmlToWordBody(html) {
    const doc=new DOMParser().parseFromString(html,'text/html');
    const out=[];
    const walk=(el)=>{
      if (el.nodeType !== Node.ELEMENT_NODE) return;
      const tag=el.tagName.toLowerCase();
      if (tag==='table') {
        const rows=Array.from(el.querySelectorAll(':scope > tbody > tr, :scope > tr'));
        if (rows.length) {
          out.push('<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>');
          for(const tr of rows){
            out.push('<w:tr>');
            for(const cell of Array.from(tr.children)){ out.push('<w:tc>'+wordParagraph(cell)+'</w:tc>'); }
            out.push('</w:tr>');
          }
          out.push('</w:tbl>');
        }
        return;
      }
      const style = tag==='h1' ? 'Heading1' : tag==='h2' ? 'Heading2' : tag==='h3' ? 'Heading3' : tag==='h4' ? 'Heading4' : null;
      const block = new Set(['p','div','li','h1','h2','h3','h4','h5','h6','blockquote','pre']);
      if (block.has(tag)) {
        const hasBlock=Array.from(el.children).some(c=>block.has(c.tagName.toLowerCase()) || c.tagName.toLowerCase()==='table');
        if (!hasBlock || ['h1','h2','h3','h4','h5','h6','p','li','blockquote','pre'].includes(tag)) {
          const text=el.textContent || '';
          if (text.trim() || el.querySelector('br')) out.push(wordParagraph(el, style));
          if (!['div'].includes(tag)) return;
        }
      }
      for(const child of Array.from(el.children)) walk(child);
    };
    for(const child of Array.from(doc.body.children)) walk(child);
    return out.join('');
  }

  function docxFromJson(json, fallbackHtml){
    const body=jsonNodeToWordXml(json) || htmlToWordBody(fallbackHtml || '') || '<w:p/>';
    const documentXml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>';
    const rels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    const styles='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:aliases w:val="Pocket"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="480"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:aliases w:val="Hat"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="480"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:u w:val="double"/><w:sz w:val="44"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:aliases w:val="Block"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="200"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:u w:val="single"/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:aliases w:val="Tag"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="200"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Analytic"><w:name w:val="Analytic"/><w:basedOn w:val="Heading4"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr></w:style></w:styles>';
    const ct='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
    return zipStore([['[Content_Types].xml',ct],['_rels/.rels',rels],['word/document.xml',documentXml],['word/styles.xml',styles],['word/_rels/document.xml.rels','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>']]);
  }

  function docxFromHtml(html){
    const body=htmlToWordBody(html) || '<w:p/>';
    const documentXml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>';
    const rels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    const styles='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/></w:rPr></w:style></w:styles>';
    const ct='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
    return zipStore([['[Content_Types].xml',ct],['_rels/.rels',rels],['word/document.xml',documentXml],['word/styles.xml',styles],['word/_rels/document.xml.rels','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>']]);
  }

  async function saveDocx(data){
    refreshState();
    const html=makeHtmlReport(data);
    // Build one combined ProseMirror-shaped document for the Word writer.
    // Metadata is kept in the report itself; each speech then contributes
    // its captured CardMirror document tree unchanged.
    const textNode = (text) => ({type:'text', text:String(text ?? '')});
    const para = (text, type='paragraph') => ({type, content:[textNode(text)]});
    const tag = (label, value) => ({
      type:'tag',
      content:[
        textNode(label+': '),
        textNode(String(value ?? ''))
      ]
    });
    const reportContent = [];

    // Top Pocket: [Tournament] [Round]---Aff [School] vs. Neg [School]
    reportContent.push({
      type:'pocket',
      content:[textNode(
        String(data.tournamentName ?? '')+' Round '+normalizedRound(data.roundNumber)+
        '---Aff '+String(data.affTeam ?? '')+' vs. Neg '+String(data.negTeam ?? '')
      )]
    });

    // Metadata between the first Pocket and the first speech Pocket.
    reportContent.push(tag('AFF', data.affTeam));
    reportContent.push(tag('NEG', data.negTeam));
    reportContent.push(tag('1AC', data.affirmative));
    reportContent.push(tag('1NC', data.negOff1NC));
    reportContent.push(tag('2NR', data.negOff2NR));
    reportContent.push(tag('Reason for Decision '+String(data.judgeName ?? ''), ''));

    for (const speech of SPEECHES) {
      reportContent.push({
        type:'pocket',
        content:[textNode(speech)]
      });
      const a=state.assignments[speech];
      if(a && a.json && Array.isArray(a.json.content)) {
        // Preserve the captured CardMirror tree. The converter knows the
        // CardMirror card/card_body/cite/undertag node types and their marks.
        reportContent.push(...a.json.content);
      }
    }

    const speechJson = {type:'doc', content:reportContent};
    const bytes=docxFromJson(speechJson, html);
    const filename=escapeFilePart(data.tournamentName)+' Round '+escapeFilePart(normalizedRound(data.roundNumber))+'---AFF '+escapeFilePart(data.affTeam)+' vs. NEG '+escapeFilePart(data.negTeam)+'.docx';
    const api=window.electronAPI;
    if (!api || typeof api.saveAs !== 'function') throw new Error('CardMirror desktop save bridge is unavailable.');
    const result=await api.saveAs(filename,bytes,{filters:[{name:'Microsoft Word (.docx)',extensions:['docx']}]});
    if(result) {
      state = { assignments: {}, form: data, updatedAt: Date.now() };
      persistState(true);
      refreshButtons();
      toast('Round report saved as '+result.name+'.');
    }
  }

  async function createReport(data){
    try { await saveDocx(data); } catch(e){ console.error('[Round Report]',e); toast('Round report failed: '+(e && e.message ? e.message : String(e))); }
  }

  function dispatchShortcut(key, opts={}) {
    const root=getActiveRoot();
    if(!root){ toast('Open a document before selecting a speech.'); return; }
    try { root.focus(); } catch (_) {}
    const ev=new KeyboardEvent('keydown',{key, code:opts.code||key, altKey:true, bubbles:true, cancelable:true});
    root.dispatchEvent(ev);
  }
  function invokeCommandShortcut(speech){
    const i=SPEECHES.indexOf(speech);
    dispatchShortcut(String(i+1),{code:'Digit'+(i+1)});
  }
  function invokeCreateShortcut(){
    // Create RR is handled directly because it does not require an active document.
    // The current plugin API is already captured by any speech command in this renderer.
    if(pluginApi){ showModal(); return; }
    // Give the user a normal plugin command path if no API has been captured yet.
    toast('Select a speech once before creating the Round Report.');
  }

  function mountUi(){
    const existing=document.getElementById('cardmirror-round-report-panel');
    const panel=document.getElementById('custom-ribbon-panel');
    if(existing && panel && panel.contains(existing)) { uiMounted=true; refreshButtons(); return true; }
    uiMounted=false;
    if(!panel) return false;
    uiMounted=true;
    const wrap=document.createElement('div'); wrap.id='cardmirror-round-report-panel'; wrap.className='rr-ribbon-panel';
    for(const speech of SPEECHES){
      const b=document.createElement('button'); b.type='button'; b.id=SPEECH_IDS[speech]; b.className='ribbon-doc-ops-btn rr-speech-btn'; b.textContent=speech; b.title='Assign current document to '+speech; b.addEventListener('mousedown',e=>e.preventDefault()); b.addEventListener('click',()=>invokeCommandShortcut(speech)); wrap.appendChild(b);
    }
    const rr=document.createElement('button'); rr.type='button'; rr.className='ribbon-doc-ops-btn rr-create-btn'; rr.textContent='RR'; rr.title='Create Round Report'; rr.addEventListener('mousedown',e=>e.preventDefault()); rr.addEventListener('click',()=>invokeCreateShortcut()); wrap.appendChild(rr);
    panel.appendChild(wrap); panel.hidden=false;
    const style=document.createElement('style'); style.id='cardmirror-round-report-style'; style.textContent='#cardmirror-round-report-panel{display:flex;align-items:center;gap:3px;margin-left:4px;padding-left:4px;border-left:1px solid var(--pmd-c-border,#ccc)} #cardmirror-round-report-panel .rr-speech-btn{min-width:34px} #cardmirror-round-report-panel .rr-speech-btn.rr-selected{background:#2e8b57!important;color:#fff!important;border-color:#246b45!important} #cardmirror-round-report-panel .rr-create-btn{margin-left:4px;font-weight:700} .rr-overlay{position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center} .rr-dialog{width:min(560px,calc(100vw - 32px));max-height:90vh;overflow:auto;background:var(--pmd-c-bg,#fff);color:var(--pmd-c-fg,#111);border:1px solid var(--pmd-c-border,#bbb);border-radius:10px;box-shadow:0 16px 50px rgba(0,0,0,.28);padding:16px;font:14px system-ui,sans-serif} .rr-header{display:flex;justify-content:space-between;align-items:center;font-size:18px;margin-bottom:14px}.rr-x{border:0;background:transparent;font-size:24px;cursor:pointer} .rr-selected-docs{margin:0 0 14px;padding:10px;border:1px solid var(--pmd-c-border,#bbb);border-radius:7px}.rr-selected-title{font-weight:700;margin-bottom:7px}.rr-selected-row{display:grid;grid-template-columns:55px 1fr;gap:8px;padding:3px 0}.rr-selected-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .rr-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}.rr-field{display:flex;flex-direction:column;gap:5px}.rr-field span{font-size:12px;font-weight:600}.rr-field input{box-sizing:border-box;width:100%;padding:8px;border:1px solid var(--pmd-c-border,#bbb);border-radius:6px;background:var(--pmd-c-bg,#fff);color:inherit}.rr-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.rr-actions button{padding:8px 14px;border-radius:6px;border:1px solid var(--pmd-c-border,#aaa);cursor:pointer}.rr-ok{font-weight:700} @media(max-width:600px){.rr-fields{grid-template-columns:1fr}}'; document.head.appendChild(style);
    document.addEventListener('focusin',e=>{const t=e.target; if(t && t.closest && t.closest('.ProseMirror')){lastFocusedRoot=t.closest('.ProseMirror'); refreshButtons();}},true);
    document.addEventListener('mousedown',e=>{const t=e.target; if(t && t.closest){const root=t.closest('.ProseMirror'); if(root){lastFocusedRoot=root;}}},true);
    const editorObserver = new MutationObserver(()=>{
      const roots = Array.from(document.querySelectorAll('.ProseMirror'));
      if (lastFocusedRoot && !lastFocusedRoot.isConnected) lastFocusedRoot = null;
      if (!lastFocusedRoot && roots.length) lastFocusedRoot = roots[0];
      refreshButtons();
    });
    editorObserver.observe(document.body,{childList:true,subtree:true});
    const ribbonObserver = new MutationObserver(()=>{ if(!document.getElementById('cardmirror-round-report-panel')) mountUi(); });
    ribbonObserver.observe(document.body,{childList:true,subtree:true});
    window.addEventListener('focus',()=>{refreshButtons();});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){refreshButtons();}});
    refreshButtons();
    return true;
  }

  const def={
    id:PLUGIN_ID,
    name:'Round Report Creator',
    apiVersion:1,
    commands:SPEECHES.map((s,i)=>({id:PLUGIN_ID+'.assign'+s,label:'Round Report: '+s,keywords:['round report',s,'speech'],defaultKey:'Alt-'+(i+1),run:(api)=>{ pluginApi=api; refreshState(); assignSpeech(s,api); }})).concat([{id:PLUGIN_ID+'.create',label:'Round Report: Create RR',keywords:['round report','create','RR'],defaultKey:'Alt-0',run:(api)=>{ pluginApi=api; refreshState(); showModal(); }}])
  };

  try { window.__registerCardMirrorPlugin?.(def); } catch(e){ console.error('[Round Report] registration failed',e); }
  refreshState();
  setupCrossWindowState();
  const timer=setInterval(()=>{ if(mountUi()){clearInterval(timer);} },200);
  setTimeout(()=>clearInterval(timer),30000);
})();
