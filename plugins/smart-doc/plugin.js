(() => {
  'use strict';

  const PLUGIN_ID = 'cardmirror-smart-doc';
  const STATE_FILE = 'round-context.json';
  const STORAGE_KEY = 'cardmirror-smart-doc-round-context-v1';
  const CHANNEL_NAME = 'cardmirror-round-context-v1';
  const SPEECHES = ['1AC','1NC','2AC','2NC','1NR','1AR','2NR','2AR'];

  let pluginApi = null;
  let stateLoaded = false;
  let state = {
    tournament: '',
    round: '',
    yourTeam: '',
    opponent: '',
    side: '',
    judge: '',
    pendingSmartDoc: null,
    updatedAt: 0,
  };
  let channel = null;
  let uiMounted = false;

  function safe(v) { return v == null ? '' : String(v); }
  function esc(v) {
    return safe(v).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  function escapeFilePart(v) {
    return safe(v).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim();
  }
  function normalizeRound(v) {
    return safe(v).trim().replace(/^round\s*/i, '').trim();
  }
  function normalizeState(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return {
      tournament: safe(r.tournament).trim(),
      round: normalizeRound(r.round),
      yourTeam: safe(r.yourTeam).trim(),
      opponent: safe(r.opponent).trim(),
      side: ['aff','neg'].includes(safe(r.side).toLowerCase()) ? safe(r.side).toLowerCase() : '',
      judge: safe(r.judge).trim(),
      pendingSmartDoc: r.pendingSmartDoc && typeof r.pendingSmartDoc === 'object'
        ? {
            filename: safe(r.pendingSmartDoc.filename),
            speech: SPEECHES.includes(r.pendingSmartDoc.speech) ? r.pendingSmartDoc.speech : '',
            createdAt: Number(r.pendingSmartDoc.createdAt || 0),
          }
        : null,
      updatedAt: Number(r.updatedAt || 0),
    };
  }

  function toast(message) {
    try { pluginApi?.showToast?.(String(message)); return; } catch (_) {}
    try { window.__cardMirrorRoundReportToast?.(String(message)); return; } catch (_) {}
    console.log('[Smart Doc]', message);
  }

  function stateUrl() {
    return new URL('./cardmirror-features/smart-doc/' + STATE_FILE, window.location.href);
  }
  function fileUrlToPath(url) {
    let p = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return p;
  }

  function setupChannel() {
    try {
      channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;
      if (!channel) return;
      channel.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.type === 'state' && msg.state) {
          const remote = normalizeState(msg.state);
          if (remote.updatedAt >= state.updatedAt) {
            state = remote;
            stateLoaded = true;
          }
        } else if (msg.type === 'request-state') {
          if (stateLoaded) broadcast();
        }
      };
      channel.postMessage({ type:'request-state' });
    } catch (_) { channel = null; }
  }
  function broadcast() {
    try { channel?.postMessage({ type:'state', state }); } catch (_) {}
  }

  async function loadState(force=false) {
    if (stateLoaded && !force) return state;
    try {
      const res = await fetch(stateUrl().href + '?t=' + Date.now(), {cache:'no-store'});
      if (res.ok) {
        state = normalizeState(await res.json());
        stateLoaded = true;
        broadcast();
        return state;
      }
    } catch (_) {}

    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (raw) state = normalizeState(raw);
    } catch (_) {}
    stateLoaded = true;
    broadcast();
    return state;
  }

  async function persistState() {
    state.updatedAt = Date.now();
    state = normalizeState(state);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}

    try {
      const api = window.electronAPI;
      if (api?.writeFileAtPath) {
        const bytes = new TextEncoder().encode(JSON.stringify(state, null, 2));
        await api.writeFileAtPath(fileUrlToPath(stateUrl()), bytes);
      }
    } catch (err) {
      console.warn('[Smart Doc] Could not persist round context:', err);
    }
    broadcast();
  }

  window.__cardMirrorRoundContext = {
    get() {
      const copy = normalizeState(state);
      copy.pendingSmartDoc = null;
      return copy;
    },
    async refresh() {
      await loadState(true);
      return this.get();
    }
  };

  function themePalette() {
    const cs = getComputedStyle(document.body);
    const bg = cs.backgroundColor || 'rgb(255,255,255)';
    const nums = bg.match(/[\d.]+/g)?.map(Number) || [255,255,255];
    const lum = 0.2126*(nums[0]||0)+0.7152*(nums[1]||0)+0.0722*(nums[2]||0);
    const dark = lum < 140;
    return dark
      ? { bg:'#202124', fg:'#f5f5f5', input:'#292a2d', border:'#5f6368', muted:'#bdc1c6' }
      : { bg:'#fff', fg:'#111', input:'#fff', border:'#b8b8b8', muted:'#666' };
  }
  function applyTheme(dialog) {
    const p = themePalette();
    for (const [k,v] of Object.entries(p)) dialog.style.setProperty('--sd-'+k, v);
  }

  function ensureStyles() {
    if (document.getElementById('cardmirror-smart-doc-style')) return;
    const style = document.createElement('style');
    style.id = 'cardmirror-smart-doc-style';
    style.textContent = `
      #cardmirror-smart-doc-panel{display:flex;flex-direction:column;gap:4px;justify-content:center;align-items:stretch;margin-left:8px;padding-left:10px;padding-right:4px;border-left:1px solid var(--pmd-c-border,#777);min-width:126px;box-sizing:border-box}
      #cardmirror-smart-doc-panel .sd-ribbon-btn{font-weight:600;min-width:116px;width:116px;white-space:nowrap;box-sizing:border-box;line-height:1.15;padding-left:8px;padding-right:8px}
      .sd-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.36);display:flex;align-items:center;justify-content:center}
      .sd-dialog{width:min(590px,calc(100vw - 32px));max-height:90vh;overflow:auto;background:var(--sd-bg);color:var(--sd-fg);border:1px solid var(--sd-border);border-radius:10px;box-shadow:0 16px 50px rgba(0,0,0,.28);padding:16px;font:14px system-ui,sans-serif}
      .sd-header{display:flex;align-items:center;justify-content:space-between;font-size:18px;margin-bottom:14px}.sd-x{border:0;background:transparent;color:inherit;font-size:24px;cursor:pointer}
      .sd-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.sd-field{display:flex;flex-direction:column;gap:5px}.sd-field span{font-size:12px;font-weight:700}
      .sd-field input,.sd-field select{box-sizing:border-box;width:100%;padding:8px;border:1px solid var(--sd-border);border-radius:6px;background:var(--sd-input);color:var(--sd-fg)}
      .sd-help,.sd-summary{font-size:12px;color:var(--sd-muted)}.sd-summary{border:1px solid var(--sd-border);border-radius:7px;padding:10px;margin-bottom:14px;line-height:1.55}
      .sd-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:16px}.sd-actions button{padding:8px 13px;border-radius:6px;border:1px solid var(--sd-border);background:var(--sd-input);color:var(--sd-fg);cursor:pointer}.sd-primary{font-weight:700}
      .sd-danger{margin-right:auto}.sd-single{max-width:360px}
      @media(max-width:600px){.sd-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function createOverlay(title) {
    ensureStyles();
    document.querySelector('.sd-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'sd-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'sd-dialog';
    dialog.innerHTML = `<div class="sd-header"><strong>${esc(title)}</strong><button type="button" class="sd-x">×</button></div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    applyTheme(dialog);
    const close = () => overlay.remove();
    dialog.querySelector('.sd-x').addEventListener('click', close);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    return {overlay, dialog, close};
  }

  async function showRoundContext() {
    await loadState(true);
    const {dialog, close} = createOverlay('Round Context');
    const grid = document.createElement('div');
    grid.className = 'sd-grid';
    dialog.appendChild(grid);

    const defs = [
      ['tournament','Tournament','e.g. Harvard'],
      ['round','Round','e.g. 4'],
      ['yourTeam','Your team','e.g. Bronx Science AB'],
      ['opponent','Opponent','e.g. Lexington CD'],
      ['judge','Judge (optional)','e.g. Jane Smith'],
    ];
    const inputs = {};
    for (const [key,label,placeholder] of defs) {
      const l = document.createElement('label'); l.className='sd-field';
      const sp = document.createElement('span'); sp.textContent=label;
      const input = document.createElement('input'); input.type='text'; input.placeholder=placeholder; input.value=safe(state[key]);
      l.append(sp,input); grid.appendChild(l); inputs[key]=input;
    }

    const sideLabel = document.createElement('label'); sideLabel.className='sd-field';
    const sideSpan = document.createElement('span'); sideSpan.textContent='Your side (optional)';
    const side = document.createElement('select');
    side.innerHTML = '<option value="">Not set</option><option value="aff">Affirmative</option><option value="neg">Negative</option>';
    side.value = state.side || '';
    sideLabel.append(sideSpan, side); grid.appendChild(sideLabel);

    const help = document.createElement('div');
    help.className='sd-help';
    help.style.marginTop='12px';
    help.textContent='Tournament, round, and opponent are used by Smart Doc. Your team, side, and judge also prefill Round Report when that feature is installed.';
    dialog.appendChild(help);

    const actions = document.createElement('div'); actions.className='sd-actions';
    const clear = document.createElement('button'); clear.type='button'; clear.className='sd-danger'; clear.textContent='Clear Round';
    const cancel = document.createElement('button'); cancel.type='button'; cancel.textContent='Cancel';
    const save = document.createElement('button'); save.type='button'; save.className='sd-primary'; save.textContent='Save Round';
    actions.append(clear,cancel,save); dialog.appendChild(actions);

    cancel.addEventListener('click', close);
    clear.addEventListener('click', async()=>{
      state = normalizeState({});
      await persistState();
      close();
      toast('Round Context cleared.');
    });
    save.addEventListener('click', async()=>{
      const next = normalizeState({
        tournament: inputs.tournament.value,
        round: inputs.round.value,
        yourTeam: inputs.yourTeam.value,
        opponent: inputs.opponent.value,
        judge: inputs.judge.value,
        side: side.value,
        pendingSmartDoc: state.pendingSmartDoc,
      });
      if (!next.tournament || !next.round || !next.opponent) {
        toast('Tournament, round, and opponent are required.');
        return;
      }
      state = next;
      await persistState();
      close();
      toast('Round Context saved.');
    });
    inputs.tournament.focus();
  }

  function contextSummary() {
    const lines = [
      `<strong>${esc(state.tournament || '—')}</strong> · Round ${esc(state.round || '—')}`,
      `Opponent: ${esc(state.opponent || '—')}`,
    ];
    if (state.yourTeam) lines.push(`Your team: ${esc(state.yourTeam)}`);
    if (state.side) lines.push(`Side: ${state.side === 'aff' ? 'Affirmative' : 'Negative'}`);
    if (state.judge) lines.push(`Judge: ${esc(state.judge)}`);
    return lines.join('<br>');
  }

  // --- Minimal DOCX writer: one Pocket (Heading 1) + one blank paragraph. ---
  function crc32(bytes){
    let c=0xffffffff;
    for(let i=0;i<bytes.length;i++){ c^=bytes[i]; for(let k=0;k<8;k++) c=(c>>>1)^((c&1)?0xedb88320:0); }
    return (~c)>>>0;
  }
  function u16(n){return [n&255,(n>>>8)&255];}
  function u32(n){return [n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255];}
  function zipStore(entries){
    const enc=new TextEncoder(), parts=[], central=[]; let offset=0;
    for(const [name,data] of entries){
      const nb=enc.encode(name), db=data instanceof Uint8Array?data:enc.encode(data), crc=crc32(db);
      const local=new Uint8Array([
        0x50,0x4b,0x03,0x04,20,0,0,0,0,0,0,0,0,0,
        ...u32(crc),...u32(db.length),...u32(db.length),...u16(nb.length),0,0,...nb
      ]);
      parts.push(local,db);
      const cen=new Uint8Array([
        0x50,0x4b,0x01,0x02,20,0,20,0,0,0,0,0,0,0,0,0,
        ...u32(crc),...u32(db.length),...u32(db.length),...u16(nb.length),0,0,0,0,0,0,0,0,0,0,0,0,...u32(offset),...nb
      ]);
      central.push(cen); offset+=local.length+db.length;
    }
    const csize=central.reduce((n,a)=>n+a.length,0), count=central.length;
    const end=new Uint8Array([0x50,0x4b,0x05,0x06,0,0,0,0,...u16(count),...u16(count),...u32(csize),...u32(offset),0,0]);
    const all=[...parts,...central,end], total=all.reduce((n,a)=>n+a.length,0), out=new Uint8Array(total);
    let p=0; for(const a of all){out.set(a,p);p+=a.length;} return out;
  }
  function xmlEsc(v){
    return safe(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  }
  function smartDocBytes(speech){
    const headingId = 'smartdoc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8);
    const documentXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' +
      '<w:bookmarkStart w:id="1" w:name="pmd-heading-'+xmlEsc(headingId)+'"/>' +
      '<w:r><w:t xml:space="preserve">'+xmlEsc(speech)+'</w:t></w:r>' +
      '<w:bookmarkEnd w:id="1"/></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr></w:p>' +
      '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
      '</w:body></w:document>';
    const styles =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr></w:rPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Pocket"/><w:aliases w:val="Pocket"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>' +
      '</w:styles>';
    const ct =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>';
    const rels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>';
    const docRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';
    return zipStore([
      ['[Content_Types].xml',ct],
      ['_rels/.rels',rels],
      ['word/document.xml',documentXml],
      ['word/styles.xml',styles],
      ['word/_rels/document.xml.rels',docRels],
    ]);
  }

  function smartFilename(speech) {
    const tournament = escapeFilePart(state.tournament);
    const round = escapeFilePart(state.round);
    const speechName = escapeFilePart(speech);
    const opponent = escapeFilePart(state.opponent);
    return `${tournament} Round ${round}---${speechName} vs. ${opponent}.docx`;
  }

  async function createSmartDoc(speech) {
    await loadState(true);
    if (!state.tournament || !state.round || !state.opponent) {
      toast('Set Round Context before creating a Smart Doc.');
      await showRoundContext();
      return;
    }
    const api = window.electronAPI;
    if (!api?.saveAs || !api?.spawnWindow) {
      toast('Smart Doc requires the CardMirror desktop app.');
      return;
    }

    const bytes = smartDocBytes(speech);
    const suggested = smartFilename(speech);
    let saved;
    try {
      saved = await api.saveAs(suggested, bytes, {
        filters:[{name:'Microsoft Word (.docx)',extensions:['docx']}]
      });
    } catch (err) {
      console.error('[Smart Doc] Save failed:', err);
      toast('Smart Doc could not be saved.');
      return;
    }
    if (!saved) return;

    state.pendingSmartDoc = {
      filename: safe(saved.name),
      speech,
      createdAt: Date.now(),
    };
    await persistState();

    try {
      await api.spawnWindow({
        filename: saved.name,
        bytes,
        handle: typeof saved.handle === 'string' ? saved.handle : null,
        format: 'docx',
        uid: null,
      });
      toast(`${speech} Smart Doc created.`);
    } catch (err) {
      console.error('[Smart Doc] Could not open created document:', err);
      state.pendingSmartDoc = null;
      await persistState();
      toast('The file was saved, but CardMirror could not open it automatically.');
    }
  }

  async function showSmartDoc() {
    await loadState(true);
    if (!state.tournament || !state.round || !state.opponent) {
      toast('Set Round Context first.');
      await showRoundContext();
      return;
    }
    const {dialog,close} = createOverlay('Create Smart Doc');
    const summary = document.createElement('div'); summary.className='sd-summary'; summary.innerHTML=contextSummary();
    dialog.appendChild(summary);

    const field = document.createElement('label'); field.className='sd-field sd-single';
    const span=document.createElement('span'); span.textContent='Speech';
    const select=document.createElement('select');
    for(const speech of SPEECHES){const o=document.createElement('option');o.value=speech;o.textContent=speech;select.appendChild(o);}
    field.append(span,select); dialog.appendChild(field);

    const preview=document.createElement('div'); preview.className='sd-help'; preview.style.marginTop='10px';
    const refreshPreview=()=>{preview.textContent='Filename: '+smartFilename(select.value);};
    select.addEventListener('change',refreshPreview); refreshPreview(); dialog.appendChild(preview);

    const actions=document.createElement('div'); actions.className='sd-actions';
    const cancel=document.createElement('button'); cancel.type='button'; cancel.textContent='Cancel';
    const edit=document.createElement('button'); edit.type='button'; edit.textContent='Edit Round Context';
    const create=document.createElement('button'); create.type='button'; create.className='sd-primary'; create.textContent='Create';
    actions.append(edit,cancel,create); dialog.appendChild(actions);

    cancel.addEventListener('click',close);
    edit.addEventListener('click',()=>{close(); void showRoundContext();});
    create.addEventListener('click',()=>{const speech=select.value;close();void createSmartDoc(speech);});
    select.focus();
  }

  function dispatchRoundReportAssignment(speech) {
    const root = document.querySelector('.ProseMirror');
    if (!root) return false;
    const i = SPEECHES.indexOf(speech);
    if (i < 0) return false;
    try { root.focus(); } catch (_) {}
    const key=String(i+1);
    const ev=new KeyboardEvent('keydown',{key,code:'Digit'+key,altKey:true,bubbles:true,cancelable:true});
    root.dispatchEvent(ev);
    return true;
  }

  async function consumePendingSmartDoc() {
    await loadState(true);
    const pending = state.pendingSmartDoc;
    if (!pending?.filename || !pending.speech) return;
    if (Date.now() - Number(pending.createdAt || 0) > 30000) {
      state.pendingSmartDoc = null; await persistState(); return;
    }

    // Only the newly-spawned document whose final filename matches the request
    // may consume it. Existing CardMirror windows receive the same shared state.
    if (!document.title.includes(pending.filename)) return;

    for (let attempt=0; attempt<40; attempt++) {
      const rrScriptInstalled = !!document.querySelector('script[src*="cardmirror-features/round-report/plugin.js"]');
      const rrReady = !!document.getElementById('cardmirror-round-report-panel');
      const root = document.querySelector('.ProseMirror');
      if (root && rrReady) {
        dispatchRoundReportAssignment(pending.speech);
        state.pendingSmartDoc = null;
        await persistState();
        return;
      }
      // Round Report is optional. If its script isn't installed at all, there
      // is nothing to integrate with; clear the pending handoff once the new
      // editor is ready. If it IS installed, keep waiting for its ribbon/API.
      if (root && !rrScriptInstalled) {
        state.pendingSmartDoc = null;
        await persistState();
        return;
      }
      await new Promise(r=>setTimeout(r,150));
    }
  }

  function mountUi() {
    ensureStyles();
    const existing=document.getElementById('cardmirror-smart-doc-panel');
    const anchor=document.getElementById('custom-ribbon-panel');
    if(existing && existing.isConnected){uiMounted=true;return true;}
    if(!anchor || !anchor.parentElement){uiMounted=false;return false;}

    const wrap=document.createElement('div');
    wrap.id='cardmirror-smart-doc-panel';
    wrap.setAttribute('role','group');
    wrap.setAttribute('aria-label','Smart Doc');

    const ctx=document.createElement('button');
    ctx.type='button';ctx.className='ribbon-doc-ops-btn sd-ribbon-btn';ctx.textContent='Round Context';
    ctx.title='Set tournament, round, opponent, side, and judge';
    ctx.addEventListener('mousedown',e=>e.preventDefault());
    ctx.addEventListener('click',()=>void showRoundContext());

    const smart=document.createElement('button');
    smart.type='button';smart.className='ribbon-doc-ops-btn sd-ribbon-btn';smart.textContent='Smart Doc';
    smart.title='Create a named speech document from the current Round Context';
    smart.addEventListener('mousedown',e=>e.preventDefault());
    smart.addEventListener('click',()=>void showSmartDoc());

    wrap.append(ctx,smart);

    // Keep Smart Doc in its own ribbon section rather than mounting inside
    // CardMirror's custom-ribbon panel. This prevents overlap with Round Report
    // and other injected feature groups.
    const rrPanel = document.getElementById('cardmirror-round-report-panel');
    const keywordPanel = document.getElementById('cardmirror-keyword-finder-panel');
    if (keywordPanel?.parentElement === anchor.parentElement) {
      keywordPanel.insertAdjacentElement('afterend', wrap);
    } else if (rrPanel?.parentElement === anchor.parentElement) {
      rrPanel.insertAdjacentElement('afterend', wrap);
    } else {
      anchor.insertAdjacentElement('afterend', wrap);
    }

    uiMounted=true;
    return true;
  }

  const def={
    id:PLUGIN_ID,
    name:'Smart Doc Creator',
    apiVersion:1,
    commands:[
      {id:PLUGIN_ID+'.context',label:'Smart Doc: Round Context',keywords:['round','context','tournament','opponent'],defaultKey:null,run:(api)=>{pluginApi=api;void showRoundContext();}},
      {id:PLUGIN_ID+'.create',label:'Smart Doc: Create',keywords:['smart','doc','speech','create'],defaultKey:null,run:(api)=>{pluginApi=api;void showSmartDoc();}},
    ],
    settings:[]
  };
  try { window.__registerCardMirrorPlugin?.(def); } catch(e){console.error('[Smart Doc] registration failed',e);}

  setupChannel();
  void loadState();
  const observer=new MutationObserver(()=>{if(!document.getElementById('cardmirror-smart-doc-panel'))mountUi();});
  observer.observe(document.documentElement,{childList:true,subtree:true});
  const timer=setInterval(()=>{mountUi();},1000);
  setTimeout(()=>clearInterval(timer),30000);
  mountUi();

  // A newly spawned Smart Doc loads this same script; consume the pending
  // request only when its window title matches the saved filename.
  setTimeout(()=>void consumePendingSmartDoc(),250);
})();