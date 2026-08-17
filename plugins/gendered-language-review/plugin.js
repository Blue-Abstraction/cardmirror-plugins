(() => {
  'use strict';

  const PLUGIN_ID = 'cardmirror-gendered-language-review';
  const PANEL_ID = 'cardmirror-gendered-language-panel';
  const STYLE_ID = 'cardmirror-gendered-language-style';

  let pluginApi = null;
  let lastApplyFailure = null;
  let lastFocusedRoot = null;
  let lastReviewContext = null;
  let reviewSessionActive = false;
  let mounted = false;

  const PRONOUN_RX = /\b(he|him|his|himself|she|her|hers|herself)\b/giu;
  const SAFE_VERBS = {
    is: 'are',
    was: 'were',
    has: 'have',
    does: 'do',
  };

  const AGREEMENT_INVARIANT_WORDS = new Set([
    'are', 'were', 'had', 'did',
    'can', 'could', 'will', 'would',
    'shall', 'should', 'may', 'might', 'must',
  ]);

  function toast(message) {
    const text = String(message);

    try {
      if (pluginApi && typeof pluginApi.showToast === 'function') {
        pluginApi.showToast(text);
        return;
      }
    } catch (_) {}

    // Ribbon clicks happen outside a command's `run(api)`, so pluginApi may
    // legitimately be unavailable. Show a tiny local notice instead of
    // failing silently.
    try {
      document.getElementById('gl-local-notice')?.remove();
      const notice = document.createElement('div');
      notice.id = 'gl-local-notice';
      notice.textContent = text;
      Object.assign(notice.style, {
        position: 'fixed',
        left: '50%',
        bottom: '34px',
        transform: 'translateX(-50%)',
        zIndex: '100001',
        maxWidth: 'min(560px, calc(100vw - 32px))',
        padding: '8px 12px',
        borderRadius: '7px',
        background: 'rgba(32,33,36,.94)',
        color: '#fff',
        font: '13px system-ui, sans-serif',
        boxShadow: '0 4px 18px rgba(0,0,0,.25)',
        pointerEvents: 'none',
        textAlign: 'center',
      });
      document.body.appendChild(notice);
      setTimeout(() => notice.remove(), 2600);
      return;
    } catch (_) {}

    console.warn('[Gendered Pronoun Review]', text);
  }

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[c]));
  }

  function preserveCase(original, replacement) {
    const src = String(original || '');
    const rep = String(replacement || '');
    if (!src) return rep;
    if (src === src.toUpperCase()) return rep.toUpperCase();
    if (src[0] === src[0].toUpperCase()) {
      return rep.charAt(0).toUpperCase() + rep.slice(1);
    }
    return rep;
  }

  function neutralOptions(word, blockText, endOffset) {
    const lower = word.toLowerCase();
    const after = blockText.slice(endOffset);

    switch (lower) {
      case 'he':
      case 'she':
        return { primary: 'they', alternatives: [], ambiguous: false, subject: true };
      case 'him':
        return { primary: 'them', alternatives: [], ambiguous: false, subject: false };
      case 'himself':
      case 'herself':
        return { primary: 'themselves', alternatives: ['themself'], ambiguous: false, subject: false };
      case 'hers':
        return { primary: 'theirs', alternatives: [], ambiguous: false, subject: false };
      case 'his': {
        // "his book" -> their; "the book is his." -> theirs.
        const next = after.match(/^\s*([\p{L}\p{N}_'-]+)?/u)?.[1] || '';
        return next
          ? { primary: 'their', alternatives: ['theirs'], ambiguous: true, subject: false }
          : { primary: 'theirs', alternatives: ['their'], ambiguous: true, subject: false };
      }
      case 'her':
        // Object-vs-determiner cannot be solved reliably without a parser.
        return { primary: 'them', alternatives: ['their'], ambiguous: true, subject: false };
      default:
        return { primary: word, alternatives: [], ambiguous: true, subject: false };
    }
  }

  function safeVerbAfter(blockText, endOffset, isSubject) {
    if (!isSubject) return null;

    // Deliberately conservative: only an immediately following auxiliary.
    const m = blockText.slice(endOffset).match(/^(\s+)(is|was|has|does)\b/i);
    if (!m) return null;

    const original = m[2];
    const neutral = preserveCase(original, SAFE_VERBS[original.toLowerCase()]);
    const start = endOffset + m[1].length;
    return {
      original,
      replacement: neutral,
      start,
      end: start + original.length,
    };
  }

  function needsManualAgreementReview(blockText, endOffset, isSubject, safeVerb) {
    if (!isSubject) return false;
    if (safeVerb) return false;

    const tail = blockText.slice(endOffset);

    // If the next token is an invariant auxiliary/modal, singular they does
    // not require any agreement edit: "he would" -> "they would", etc.
    const direct = tail.match(/^\s+([\p{L}'-]+)\b/u);
    if (direct) {
      const next = direct[1].toLowerCase();
      if (AGREEMENT_INVARIANT_WORDS.has(next)) return false;
    }

    // Anything else is deliberately human-reviewed. This includes ordinary
    // 3rd-person verbs ("runs"), intervening adverbs/clauses, punctuation,
    // and structures our tiny rule set cannot reliably parse.
    return true;
  }

  function activeRoot() {
    if (lastFocusedRoot?.isConnected) return lastFocusedRoot;

    const active = document.activeElement;
    const focused = active instanceof Element ? active.closest('.ProseMirror') : null;
    if (focused instanceof HTMLElement) return focused;

    return [...document.querySelectorAll('.ProseMirror')].find(root => {
      if (!(root instanceof HTMLElement)) return false;
      const rect = root.getBoundingClientRect();
      const cs = getComputedStyle(root);
      return cs.display !== 'none' && cs.visibility !== 'hidden' &&
             rect.width > 0 && rect.height > 0;
    }) || null;
  }

  function captureSelectionSnapshot(root) {
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0) return { root, range: null };

    try {
      const range = sel.getRangeAt(0);
      const common = range.commonAncestorContainer;
      const commonEl = common instanceof Element ? common : common.parentElement;
      if (!commonEl || !root.contains(commonEl)) return { root, range: null };
      return { root, range: range.cloneRange() };
    } catch (_) {
      return { root, range: null };
    }
  }

  function restoreSelectionSnapshot(snapshot) {
    const root = snapshot?.root;
    if (!(root instanceof HTMLElement) || !root.isConnected) return false;

    try { root.focus({ preventScroll: true }); } catch (_) {
      try { root.focus(); } catch (_) {}
    }

    const sel = window.getSelection?.();
    if (!sel) return false;

    try {
      const range = snapshot?.range;
      if (
        range &&
        range.startContainer?.isConnected &&
        range.endContainer?.isConnected
      ) {
        sel.removeAllRanges();
        sel.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return true;
      }
    } catch (_) {}

    // If ProseMirror replaced the original DOM nodes during an accepted edit,
    // leave a harmless caret at the start of the same editor rather than
    // leaving our internal preview selection behind.
    try {
      const fallback = document.createRange();
      fallback.selectNodeContents(root);
      fallback.collapse(true);
      sel.removeAllRanges();
      sel.addRange(fallback);
      document.dispatchEvent(new Event('selectionchange'));
      return true;
    } catch (_) {
      return false;
    }
  }

  function textNodesIn(block) {
    const out = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) out.push(node);
    return out;
  }

  function topLevelChildForNode(root, node) {
    let el = node instanceof Element ? node : node?.parentElement;
    while (el && el.parentElement !== root) el = el.parentElement;
    return el?.parentElement === root ? el : null;
  }

  function isCardElement(el) {
    if (!(el instanceof HTMLElement)) return false;

    // Prefer ProseMirror's own live node descriptor so this survives CSS/class
    // refactors. CardMirror models `card` as a real schema node.
    try {
      if (el.pmViewDesc?.node?.type?.name === 'card') return true;
    } catch (_) {}

    // Conservative fallbacks for renderer builds that don't expose pmViewDesc
    // directly on the top-level node.
    return el.classList.contains('pmd-card') ||
           el.getAttribute('data-node-type') === 'card' ||
           el.getAttribute('data-type') === 'card';
  }

  function offsetWithinBlock(block, container, offset) {
    try {
      const range = document.createRange();
      range.selectNodeContents(block);
      range.setEnd(container, offset);
      const n = range.toString().length;
      range.detach?.();
      return n;
    } catch (_) {
      return null;
    }
  }

  /**
   * Resolve exactly what the user asked us to review:
   *   1. Non-collapsed selection inside the active editor -> only that selection.
   *   2. Otherwise -> the actual CardMirror card containing the cursor.
   *
   * Returns [{ blockIndex, start, end }] where start/end are character offsets
   * in the top-level ProseMirror child. This keeps the existing bottom-up edit
   * application machinery intact.
   */
  function reviewScope(root) {
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);
    const startTop = topLevelChildForNode(root, range.startContainer);
    const endTop = topLevelChildForNode(root, range.endContainer);

    // Selection wins over current-card behavior.
    if (!range.collapsed && startTop && endTop) {
      const children = Array.from(root.children).filter(
        el => el instanceof HTMLElement
      );
      const startIndex = children.indexOf(startTop);
      const endIndex = children.indexOf(endTop);
      if (startIndex < 0 || endIndex < 0) return null;

      const lo = Math.min(startIndex, endIndex);
      const hi = Math.max(startIndex, endIndex);
      const scopes = [];

      for (let blockIndex = lo; blockIndex <= hi; blockIndex++) {
        const block = children[blockIndex];
        const model = blockModel(block);

        let start = 0;
        let end = model.text.length;

        if (block === startTop) {
          const v = offsetWithinBlock(
            block, range.startContainer, range.startOffset
          );
          if (v != null) start = v;
        }
        if (block === endTop) {
          const v = offsetWithinBlock(
            block, range.endContainer, range.endOffset
          );
          if (v != null) end = v;
        }

        // Defensive support for reverse/odd browser selections.
        const a = Math.max(0, Math.min(start, end));
        const b = Math.min(model.text.length, Math.max(start, end));
        if (b > a) scopes.push({ blockIndex, start: a, end: b });
      }

      return scopes.length ? { kind: 'selection', scopes } : null;
    }

    // No selection: require the cursor to be inside a real CardMirror card.
    const anchorTop = topLevelChildForNode(root, sel.anchorNode);
    if (!anchorTop || !isCardElement(anchorTop)) return null;

    const children = Array.from(root.children).filter(
      el => el instanceof HTMLElement
    );
    const blockIndex = children.indexOf(anchorTop);
    if (blockIndex < 0) return null;

    const model = blockModel(anchorTop);
    return {
      kind: 'card',
      scopes: [{ blockIndex, start: 0, end: model.text.length }],
    };
  }

  function selectionRoot() {
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0) return null;

    const node = sel.anchorNode;
    const el = node instanceof Element ? node : node?.parentElement;
    const root = el?.closest?.('.ProseMirror');
    return root instanceof HTMLElement ? root : null;
  }

  /**
   * Cache the last valid editor scope while CardMirror still owns the browser
   * selection. Opening the ribbon or Smart Search can move DOM focus elsewhere,
   * but the user still expects the command to act on the card/selection they
   * were just editing.
   */
  function captureLiveReviewContext() {
    if (reviewSessionActive) return lastReviewContext;

    const root = selectionRoot();
    if (!(root instanceof HTMLElement)) return lastReviewContext;

    const scopeInfo = reviewScope(root);
    if (!scopeInfo) return lastReviewContext;

    lastFocusedRoot = root;
    lastReviewContext = {
      root,
      scopeInfo,
      selectionSnapshot: captureSelectionSnapshot(root),
    };
    return lastReviewContext;
  }

  function bestReviewContext() {
    // Prefer the live editor selection when one still exists.
    const live = captureLiveReviewContext();
    if (
      live?.root instanceof HTMLElement &&
      live.root.isConnected &&
      live.scopeInfo
    ) {
      return live;
    }

    // Otherwise use the last valid scope captured before CardMirror's ribbon /
    // command palette took focus.
    if (
      lastReviewContext?.root instanceof HTMLElement &&
      lastReviewContext.root.isConnected &&
      lastReviewContext.scopeInfo
    ) {
      return lastReviewContext;
    }

    return null;
  }

  /**
   * Build the block's exact text while masking already-struck language with
   * spaces of equal length. Equal-length masking keeps DOM offsets stable.
   */
  function blockModel(block) {
    let text = '';
    let scanText = '';
    const entries = [];

    for (const node of textNodesIn(block)) {
      const value = node.nodeValue || '';
      const start = text.length;
      text += value;

      const alreadyStruck = !!node.parentElement?.closest?.('s, strike, del');
      scanText += alreadyStruck ? ' '.repeat(value.length) : value;

      entries.push({ node, start, end: start + value.length });
    }

    return { text, scanText, entries };
  }

  function collectCandidates(root, scopeInfo) {
    const candidates = [];
    const blocks = Array.from(root.children).filter(
      el => el instanceof HTMLElement
    );

    for (const scope of scopeInfo.scopes) {
      const block = blocks[scope.blockIndex];
      if (!(block instanceof HTMLElement)) continue;

      const model = blockModel(block);
      const scanStart = Math.max(0, Math.min(scope.start, model.scanText.length));
      const scanEnd = Math.max(scanStart, Math.min(scope.end, model.scanText.length));
      const scopedText = model.scanText.slice(scanStart, scanEnd);

      PRONOUN_RX.lastIndex = 0;
      let m;

      while ((m = PRONOUN_RX.exec(scopedText))) {
        const original = m[0];
        const start = scanStart + m.index;
        const end = start + original.length;
        const neutral = neutralOptions(original, model.text, end);
        const replacement = preserveCase(original, neutral.primary);
        const alternatives = neutral.alternatives.map(
          x => preserveCase(original, x)
        );
        const verb = safeVerbAfter(model.text, end, neutral.subject);
        const manualAgreementReview = needsManualAgreementReview(
          model.text,
          end,
          neutral.subject,
          verb
        );

        // A verb correction is only in scope if the entire verb is also inside
        // the user's selected range. Current-card scope naturally includes it.
        const scopedVerb = verb &&
          verb.start >= scanStart &&
          verb.end <= scanEnd
            ? verb
            : null;

        const contextStart = Math.max(scanStart, start - 90);
        const contextEnd = Math.min(scanEnd, end + 110);
        const expandedContextStart = Math.max(scanStart, start - 320);
        const expandedContextEnd = Math.min(scanEnd, end + 340);

        candidates.push({
          blockIndex: scope.blockIndex,
          start,
          end,
          original,
          replacement,
          alternatives,
          ambiguous: neutral.ambiguous,
          contextBefore: model.text.slice(contextStart, start),
          contextWord: model.text.slice(start, end),
          contextAfter: model.text.slice(end, contextEnd),
          expandedContextBefore: model.text.slice(expandedContextStart, start),
          expandedContextAfter: model.text.slice(end, expandedContextEnd),
          hasMoreContext:
            expandedContextStart < contextStart ||
            expandedContextEnd > contextEnd,
          verb: scopedVerb,
          needsVerbReview:
            manualAgreementReview ||
            (!!verb && !scopedVerb),
        });

        if (!m[0].length) PRONOUN_RX.lastIndex++;
      }
    }

    return candidates;
  }

  function domPointForOffset(block, target, isEnd = false) {
    const nodes = textNodesIn(block);
    let absolute = 0;
    let lastText = null;

    for (const node of nodes) {
      const len = (node.nodeValue || '').length;
      const nodeStart = absolute;
      const nodeEnd = absolute + len;
      lastText = node;

      /*
       * Start positions use [start,end): a boundary belongs to the NEXT text
       * node. End positions use (start,end]: a boundary belongs to the
       * PREVIOUS text node. This makes ranges around marked-run boundaries
       * deterministic.
       */
      const belongs = isEnd
        ? (target > nodeStart && target <= nodeEnd) ||
          (target === 0 && nodeStart === 0)
        : target >= nodeStart && target < nodeEnd;

      if (belongs) {
        return {
          node,
          offset: Math.max(0, Math.min(len, target - nodeStart)),
        };
      }

      absolute = nodeEnd;
    }

    // Allow a caret/range endpoint at the absolute end of the block.
    if (lastText && target === absolute) {
      return {
        node: lastText,
        offset: (lastText.nodeValue || '').length,
      };
    }

    return null;
  }

  function domRangeForOffsets(block, start, end) {
    const a = domPointForOffset(block, start, false);
    const b = domPointForOffset(block, end, true);
    if (!a || !b) return null;

    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    return range;
  }

  function setEditorSelectionNow(
    root,
    blockIndex,
    start,
    end,
    collapseToEnd = false
  ) {
    /*
     * Focus FIRST. On macOS, focusing a ProseMirror view can synchronously
     * normalize/rebuild inline DOM. A Range created before focus can therefore
     * keep stale boundary nodes and expand to the surrounding formatted run.
     */
    try { root.focus({ preventScroll: true }); } catch (_) { root.focus(); }

    // Reacquire the live block AFTER focus in case ProseMirror replaced it.
    const block = root.children[blockIndex];
    if (!(block instanceof HTMLElement)) return false;

    const range = domRangeForOffsets(block, start, end);
    if (!range) return false;
    if (collapseToEnd) range.collapse(false);

    const sel = window.getSelection?.();
    if (!sel) return false;

    sel.removeAllRanges();

    // setBaseAndExtent is more explicit than addRange about exact text-node
    // boundary offsets. Fall back to addRange on older Chromium builds.
    try {
      sel.setBaseAndExtent(
        range.startContainer,
        range.startOffset,
        range.endContainer,
        range.endOffset
      );
    } catch (_) {
      sel.addRange(range);
    }

    return collapseToEnd
      ? sel.isCollapsed
      : (!sel.isCollapsed && sel.rangeCount > 0);
  }

  async function setEditorSelection(
    root,
    blockIndex,
    start,
    end,
    collapseToEnd = false
  ) {
    const ok = setEditorSelectionNow(
      root,
      blockIndex,
      start,
      end,
      collapseToEnd
    );
    if (!ok) return false;

    // Formatting/comment commands need CardMirror's ProseMirror state to catch
    // up with the browser selection before the native ribbon command fires.
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise(r =>
      requestAnimationFrame(() => requestAnimationFrame(r))
    );

    const sel = window.getSelection?.();
    return collapseToEnd ? !!sel?.isCollapsed : !!sel && !sel.isCollapsed;
  }

  async function previewCandidate(root, candidate) {
    const block = root.children[candidate.blockIndex];
    if (block instanceof HTMLElement) {
      block.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    await setEditorSelection(
      root, candidate.blockIndex, candidate.start, candidate.end, false
    );
  }

  function textAround(block, start, end, radius = 36) {
    if (!(block instanceof HTMLElement)) return '';
    const text = blockModel(block).text;
    const from = Math.max(0, start - radius);
    const to = Math.min(text.length, end + radius);
    return text.slice(from, to);
  }

  function failApply(stage, message, details = {}) {
    lastApplyFailure = {
      stage,
      message,
      ...details,
    };
    console.warn('[Gendered Pronoun Review]', stage, message, details);
    return false;
  }

  async function replaceSelectedText(
    root,
    blockIndex,
    start,
    end,
    expectedOriginal,
    replacement
  ) {
    lastApplyFailure = null;

    /*
     * Focus first, then reacquire the block and construct the exact Range from
     * the CURRENT DOM. This is the macOS-specific fix for stale ranges that
     * expanded "him" into an entire formatted run.
     */
    try { root.focus({ preventScroll: true }); } catch (_) { root.focus(); }

    const block = root.children[blockIndex];
    if (!(block instanceof HTMLElement)) {
      return failApply(
        'resolve-block',
        'The reviewed card/paragraph no longer exists after CardMirror focused the editor.'
      );
    }

    const exactRange = domRangeForOffsets(block, start, end);
    if (!exactRange) {
      return failApply(
        'build-source-range',
        'The exact source range could not be rebuilt after focusing CardMirror.',
        { around: textAround(block, start, end) }
      );
    }

    const rangeText = exactRange.toString();
    if (rangeText !== expectedOriginal) {
      return failApply(
        'verify-dom-range',
        `The rebuilt DOM Range should contain "${expectedOriginal}" but contained "${rangeText}".`,
        { around: textAround(block, start, end) }
      );
    }

    const sel = window.getSelection?.();
    if (!sel) {
      return failApply(
        'get-browser-selection',
        'Chromium did not expose a browser Selection for the focused editor.'
      );
    }

    sel.removeAllRanges();
    try {
      sel.setBaseAndExtent(
        exactRange.startContainer,
        exactRange.startOffset,
        exactRange.endContainer,
        exactRange.endOffset
      );
    } catch (_) {
      sel.addRange(exactRange);
    }

    const selectedText = sel.toString();
    if (selectedText !== expectedOriginal) {
      return failApply(
        'verify-browser-selection',
        `The DOM Range was exact, but Chromium expanded the live selection from "${expectedOriginal}" to "${selectedText}".`,
        {
          expected: expectedOriginal,
          observed: selectedText,
          around: textAround(block, start, end),
        }
      );
    }

    const expectedInsertedText = `${expectedOriginal} [${replacement}]`;
    const activeBefore = document.activeElement === root
      ? 'editor'
      : (document.activeElement?.tagName || 'unknown');

    let commandReturn = null;
    let commandError = '';
    try {
      commandReturn = document.execCommand(
        'insertText',
        false,
        expectedInsertedText
      );
    } catch (err) {
      commandError = err instanceof Error ? err.message : String(err);
    }

    // Only AFTER the native edit request do we let ProseMirror reconcile.
    await new Promise(r =>
      requestAnimationFrame(() => requestAnimationFrame(r))
    );

    const liveBlock = root.children[blockIndex];
    if (!(liveBlock instanceof HTMLElement)) {
      return failApply(
        'verify-insert',
        'CardMirror rebuilt the edited block before the replacement could be verified.',
        {
          activeBefore,
          commandReturn,
          commandError,
        }
      );
    }

    const liveText = blockModel(liveBlock).text;
    const observed = liveText.slice(
      start,
      Math.min(liveText.length, start + expectedInsertedText.length)
    );

    if (observed !== expectedInsertedText) {
      return failApply(
        'insert-text',
        'The exact bracketed replacement did not appear at the reviewed position.',
        {
          expected: expectedInsertedText,
          observed,
          around: textAround(liveBlock, start, start + Math.max(1, observed.length)),
          activeBefore,
          commandReturn,
          commandError,
          queryCommandEnabled:
            typeof document.queryCommandEnabled === 'function'
              ? (() => {
                  try { return document.queryCommandEnabled('insertText'); }
                  catch (_) { return null; }
                })()
              : null,
        }
      );
    }

    return true;
  }

  async function clearInlineFormatting(root, blockIndex, start, end) {
    const ok = await setEditorSelection(root, blockIndex, start, end, false);
    if (!ok) {
      return failApply(
        'select-for-clear-formatting',
        'The edit was inserted, but CardMirror could not reselect the original word to clear its formatting.'
      );
    }

    const btn = document.getElementById('normal-btn');
    if (!(btn instanceof HTMLButtonElement)) {
      return failApply(
        'find-clear-formatting-command',
        "CardMirror's native Clear formatting button was unavailable."
      );
    }

    btn.click();
    await new Promise(r =>
      requestAnimationFrame(() => requestAnimationFrame(r))
    );
    return true;
  }

  async function setRangeFontSize(
    root,
    blockIndex,
    start,
    end,
    points
  ) {
    const ok = await setEditorSelection(root, blockIndex, start, end, false);
    if (!ok) {
      return failApply(
        'select-for-font-size',
        'The edit was inserted, but CardMirror could not reselect the original word to shrink it.'
      );
    }

    const input = document.getElementById('font-size-input');
    if (!(input instanceof HTMLInputElement)) {
      return failApply(
        'find-font-size-control',
        "CardMirror's native font-size control was unavailable."
      );
    }

    const value = String(points);

    try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); }
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }));
    input.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }));

    await new Promise(r =>
      requestAnimationFrame(() => requestAnimationFrame(r))
    );
    return true;
  }

  async function prepareOriginalEvidenceEdit(
    root,
    blockIndex,
    start,
    end
  ) {
    // Order matters: Clear -> 8 pt -> Strikethrough.
    if (!await clearInlineFormatting(root, blockIndex, start, end)) {
      return false;
    }
    if (!await setRangeFontSize(root, blockIndex, start, end, 8)) {
      return false;
    }
    return true;
  }

  async function strikeRange(root, blockIndex, start, end) {
    const ok = await setEditorSelection(root, blockIndex, start, end, false);
    if (!ok) {
      return failApply(
        'select-for-strikethrough',
        'The replacement was inserted, but CardMirror could not reselect the original word for strikethrough.'
      );
    }

    const btn = document.getElementById('strikethrough-btn');
    if (!(btn instanceof HTMLButtonElement)) {
      return failApply(
        'find-strikethrough-command',
        'The replacement was inserted, but CardMirror\'s native Strikethrough button was unavailable.'
      );
    }

    btn.click();
    await new Promise(r =>
      requestAnimationFrame(() => requestAnimationFrame(r))
    );
    return true;
  }

  async function fillNewComment(text) {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const inputs = [
        ...document.querySelectorAll('textarea.pmd-comment-reply-input')
      ];
      const ta =
        inputs.find(x => x.offsetParent !== null) ||
        inputs[inputs.length - 1];
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

  async function addAgreementReviewComment(root, blockIndex, start, end) {
    const ok = await setEditorSelection(root, blockIndex, start, end, false);
    if (!ok) return false;

    const btn = document.getElementById('comments-add-btn');
    if (!(btn instanceof HTMLButtonElement)) return false;

    btn.click();
    return await fillNewComment(
      'Check subject–verb agreement after gender-neutral pronoun edit.'
    );
  }

  /**
   * Transparent debate-evidence edit:
   *   original -> ~~original~~ [replacement]
   *
   * Insert first, then select the still-unshifted original and invoke
   * CardMirror's native strikethrough command.
   */
  async function applyTransparentEdit(
    root,
    blockIndex,
    start,
    end,
    original,
    replacement
  ) {
    const replaced = await replaceSelectedText(
      root,
      blockIndex,
      start,
      end,
      original,
      replacement
    );
    if (!replaced) return false;

    // The source word is still at the same start/end positions because the
    // bracketed supplement was inserted AFTER it inside the same replacement.
    //
    // Remove inline evidence styling, shrink to 8 pt, then strike last.
    const prepared = await prepareOriginalEvidenceEdit(
      root,
      blockIndex,
      start,
      end
    );
    if (!prepared) return false;

    return await strikeRange(root, blockIndex, start, end);
  }

  async function applyDecision(root, decision) {
    const c = decision.candidate;

    // The verb occurs after the pronoun. Apply it FIRST so its offsets are still
    // valid. Then editing the earlier pronoun cannot invalidate the completed verb.
    if (decision.applyVerb && c.verb) {
      const okVerb = await applyTransparentEdit(
        root,
        c.blockIndex,
        c.verb.start,
        c.verb.end,
        c.verb.original,
        decision.verbReplacement
      );
      if (!okVerb) return false;
    }

    const okPronoun = await applyTransparentEdit(
      root,
      c.blockIndex,
      c.start,
      c.end,
      c.original,
      decision.replacement
    );
    if (!okPronoun) return false;

    if (decision.addVerbReviewComment) {
      const commented = await addAgreementReviewComment(
        root,
        c.blockIndex,
        c.start,
        c.end
      );
      if (!commented) {
        console.warn(
          '[Gendered Pronoun Review] edit applied but agreement comment failed'
        );
      }
    }

    return true;
  }

  function palette() {
    const bg = getComputedStyle(document.body).backgroundColor || 'rgb(255,255,255)';
    const nums = bg.match(/[\d.]+/g)?.map(Number) || [255,255,255];
    const lum = 0.2126*(nums[0]||0)+0.7152*(nums[1]||0)+0.0722*(nums[2]||0);
    return lum < 140
      ? {bg:'#202124', fg:'#f5f5f5', input:'#292a2d', border:'#5f6368', muted:'#bdc1c6'}
      : {bg:'#fff', fg:'#111', input:'#fff', border:'#b8b8b8', muted:'#666'};
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID}{display:flex;flex-direction:column;gap:4px;justify-content:center;align-items:stretch;margin-left:8px;padding-left:8px;padding-right:4px;border-left:1px solid var(--pmd-c-border,#777);min-width:138px;box-sizing:border-box}
      #${PANEL_ID} .gl-ribbon-btn{font-weight:600;min-width:130px;width:130px;min-height:40px;box-sizing:border-box;padding:4px 7px;text-align:center;display:flex !important;align-items:center;justify-content:center}
      #${PANEL_ID} .gl-ribbon-label{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;white-space:nowrap;line-height:1.08}
      #${PANEL_ID} .gl-ribbon-label>span{display:block;white-space:nowrap}
      .gl-overlay{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.36);display:flex;align-items:center;justify-content:center}
      .gl-dialog{width:min(650px,calc(100vw - 32px));max-height:90vh;overflow:auto;background:var(--gl-bg);color:var(--gl-fg);border:1px solid var(--gl-border);border-radius:10px;box-shadow:0 16px 50px rgba(0,0,0,.30);padding:17px;font:14px system-ui,sans-serif}
      .gl-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.gl-title{font-size:18px;font-weight:700}.gl-progress{font-size:12px;color:var(--gl-muted)}
      .gl-context{border:1px solid var(--gl-border);border-radius:8px;padding:12px;line-height:1.55;margin:10px 0 6px;white-space:pre-wrap}
      .gl-context mark{padding:1px 3px;border-radius:3px;font-weight:700}
      .gl-context-controls{display:flex;justify-content:flex-end;margin:0 0 12px}
      .gl-context-toggle{border:0;background:transparent;color:var(--gl-muted);padding:3px 2px;font:12px system-ui,sans-serif;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
      .gl-context-toggle:hover{color:var(--gl-fg)}
      .gl-row{display:grid;grid-template-columns:120px 1fr;align-items:center;gap:10px;margin:9px 0}.gl-row label{font-size:12px;font-weight:700}
      .gl-input{box-sizing:border-box;width:100%;padding:8px;border:1px solid var(--gl-border);border-radius:6px;background:var(--gl-input);color:var(--gl-fg)}
      .gl-note{font-size:12px;color:var(--gl-muted);line-height:1.45;margin:8px 0}.gl-warn{font-size:12px;line-height:1.45;margin:8px 0}
      .gl-verb{border:1px solid var(--gl-border);border-radius:7px;padding:10px;margin-top:10px}
      .gl-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:16px}.gl-actions button{padding:8px 13px;border:1px solid var(--gl-border);border-radius:6px;background:var(--gl-input);color:var(--gl-fg);cursor:pointer}.gl-primary{font-weight:700}.gl-stop{margin-right:auto}
      .gl-result{text-align:center}.gl-result strong{font-size:18px}
      @media(max-width:560px){.gl-row{grid-template-columns:1fr;gap:4px}}
    `;
    document.head.appendChild(style);
  }

  function makeOverlay(title) {
    ensureStyles();
    document.querySelector('.gl-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'gl-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'gl-dialog';

    const p = palette();
    for (const [k,v] of Object.entries(p)) {
      dialog.style.setProperty('--gl-' + k, v);
    }

    const header = document.createElement('div');
    header.className = 'gl-header';
    header.innerHTML = `<div class="gl-title">${escapeHtml(title)}</div>`;
    dialog.appendChild(header);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    return { overlay, dialog, header, close: () => overlay.remove() };
  }

  function buildContextHtml(c, expanded = false) {
    const before = expanded ? c.expandedContextBefore : c.contextBefore;
    const after = expanded ? c.expandedContextAfter : c.contextAfter;
    return `${escapeHtml(before)}<mark>${escapeHtml(c.contextWord)}</mark>${escapeHtml(after)}`;
  }

  async function applyQueued(
    root,
    decisions,
    closeReview,
    selectionSnapshot,
    finishReview
  ) {
    closeReview();

    if (!decisions.length) {
      finishReview();
      toast('No gendered-language edits were accepted.');
      return;
    }

    // Reverse document order: edits later in the document cannot shift the
    // block offsets of edits we still need to make earlier.
    decisions.sort((a,b) =>
      b.candidate.blockIndex - a.candidate.blockIndex ||
      b.candidate.start - a.candidate.start
    );

    let applied = 0;
    for (const decision of decisions) {
      const ok = await applyDecision(root, decision);
      if (!ok) {
        finishReview();
        const { dialog } = makeOverlay('Gendered Pronoun Review');
        dialog.innerHTML += `
          <div class="gl-result">
            <p><strong>${applied}</strong> edit${applied === 1 ? '' : 's'} applied before CardMirror rejected an edit.</p>
            <p class="gl-note">The review stopped to avoid corrupting the document. Save/check the document before trying again.</p>
            <div class="gl-warn">
              <strong>Failure stage:</strong>
              ${escapeHtml(lastApplyFailure?.stage || 'unknown')}
              <br>
              ${escapeHtml(lastApplyFailure?.message || 'No diagnostic message was captured.')}
            </div>
            ${
              lastApplyFailure?.around
                ? `<div class="gl-context"><strong>Observed text near failure:</strong><br>${escapeHtml(lastApplyFailure.around)}</div>`
                : ''
            }
            ${
              lastApplyFailure?.expected || lastApplyFailure?.observed
                ? `<div class="gl-note">Expected: ${escapeHtml(lastApplyFailure?.expected || '')}<br>Observed: ${escapeHtml(lastApplyFailure?.observed || '')}</div>`
                : ''
            }
            <div class="gl-actions"><button class="gl-primary" id="gl-result-ok">OK</button></div>
          </div>`;
        dialog.querySelector('#gl-result-ok')?.addEventListener('click', () => {
          dialog.closest('.gl-overlay')?.remove();
        });
        return;
      }
      applied++;
    }

    finishReview();

    const { dialog } = makeOverlay('Gendered Pronoun Review');
    dialog.innerHTML += `
      <div class="gl-result">
        <p><strong>${applied}</strong> accepted occurrence${applied === 1 ? '' : 's'} updated.</p>
        <p class="gl-note">Original wording was preserved with strikethrough and neutral wording was added in brackets.</p>
        <div class="gl-actions"><button class="gl-primary" id="gl-result-ok">OK</button></div>
      </div>`;
    dialog.querySelector('#gl-result-ok')?.addEventListener('click', () => {
      dialog.closest('.gl-overlay')?.remove();
    });
  }

  async function startReview(prepared = null) {
    const context = prepared?.scopeInfo ? prepared : bestReviewContext();
    const root = context?.root || activeRoot();

    if (!(root instanceof HTMLElement)) {
      toast('Open a document before starting Gendered Pronoun Review.');
      return;
    }

    const selectionSnapshot =
      context?.selectionSnapshot || captureSelectionSnapshot(root);
    const scopeInfo = context?.scopeInfo || reviewScope(root);

    if (!scopeInfo) {
      toast('Select text to review, or place the cursor inside a card.');
      return;
    }

    lastFocusedRoot = root;

    const candidates = collectCandidates(root, scopeInfo);
    if (!candidates.length) {
      toast(
        scopeInfo.kind === 'selection'
          ? 'No supported gendered pronouns were found in the selected text.'
          : 'No supported gendered pronouns were found in the current card.'
      );
      return;
    }

    const decisions = new Map();
    let index = 0;
    reviewSessionActive = true;

    const acceptedDecisions = () => [...decisions.values()];

    const { dialog, header, close: rawClose } = makeOverlay('Gendered Pronoun Review');
    const finishReview = () => {
      reviewSessionActive = false;
      restoreSelectionSnapshot(selectionSnapshot);
      setTimeout(captureLiveReviewContext, 0);
    };
    const close = () => {
      rawClose();
      finishReview();
    };

    async function render() {
      if (index >= candidates.length) {
        dialog.innerHTML = `
          <div class="gl-header">
            <div class="gl-title">Review complete</div>
            <div class="gl-progress">${candidates.length} occurrence${candidates.length === 1 ? '' : 's'} reviewed</div>
          </div>
          <div class="gl-result">
            <p><strong>${decisions.size}</strong> accepted change${decisions.size === 1 ? '' : 's'} queued.</p>
            <p class="gl-note">Nothing has been changed yet. Apply will edit from the bottom of the document upward so earlier locations remain stable.</p>
          </div>
          <div class="gl-actions">
            <button class="gl-stop" id="gl-discard">Discard</button>
            <button id="gl-summary-back">Back</button>
            <button class="gl-primary" id="gl-apply">Apply Changes</button>
          </div>`;

        dialog.querySelector('#gl-discard')?.addEventListener('click', close);
        dialog.querySelector('#gl-summary-back')?.addEventListener('click', () => {
          index = Math.max(0, candidates.length - 1);
          void render();
        });
        dialog.querySelector('#gl-apply')?.addEventListener('click', () => {
          void applyQueued(
            root,
            acceptedDecisions(),
            rawClose,
            selectionSnapshot,
            finishReview
          );
        });
        return;
      }

      const c = candidates[index];
      const savedDecision = decisions.get(index) || null;
      await previewCandidate(root, c);

      header.innerHTML = `
        <div class="gl-title">Gendered Pronoun Review</div>
        <div class="gl-progress">${index + 1} of ${candidates.length}</div>`;

      dialog.querySelectorAll(':scope > :not(.gl-header)').forEach(el => el.remove());

      const context = document.createElement('div');
      context.className = 'gl-context';
      let contextExpanded = false;

      const renderContext = () => {
        context.innerHTML = buildContextHtml(c, contextExpanded);
      };
      renderContext();
      dialog.appendChild(context);

      if (c.hasMoreContext) {
        const contextControls = document.createElement('div');
        contextControls.className = 'gl-context-controls';

        const contextToggle = document.createElement('button');
        contextToggle.type = 'button';
        contextToggle.className = 'gl-context-toggle';
        contextToggle.textContent = 'Show More Context';
        contextToggle.addEventListener('click', () => {
          contextExpanded = !contextExpanded;
          renderContext();
          contextToggle.textContent =
            contextExpanded ? 'Show Less Context' : 'Show More Context';
        });

        contextControls.appendChild(contextToggle);
        dialog.appendChild(contextControls);
      }

      const row = document.createElement('div');
      row.className = 'gl-row';
      const label = document.createElement('label');
      label.textContent = `${c.original} →`;
      const input = document.createElement('input');
      input.className = 'gl-input';
      input.type = 'text';
      input.value = savedDecision?.replacement ?? c.replacement;
      input.setAttribute('aria-label', 'Neutral pronoun replacement');
      row.append(label, input);
      dialog.appendChild(row);

      if (c.alternatives.length) {
        const note = document.createElement('div');
        note.className = 'gl-note';
        note.textContent = `Possible alternative: ${c.alternatives.join(' / ')}. This form is grammatically ambiguous, so edit the replacement if needed.`;
        dialog.appendChild(note);
      }

      let verbCheck = null;
      let verbInput = null;
      if (c.verb) {
        const verbBox = document.createElement('div');
        verbBox.className = 'gl-verb';

        const checkLabel = document.createElement('label');
        verbCheck = document.createElement('input');
        verbCheck.type = 'checkbox';
        verbCheck.checked =
          savedDecision ? !!savedDecision.applyVerb : true;
        checkLabel.append(verbCheck, document.createTextNode(
          ` Also correct agreement: ${c.verb.original} → ${c.verb.replacement}`
        ));
        verbBox.appendChild(checkLabel);

        const verbRow = document.createElement('div');
        verbRow.className = 'gl-row';
        const vl = document.createElement('label');
        vl.textContent = 'Verb replacement';
        verbInput = document.createElement('input');
        verbInput.className = 'gl-input';
        verbInput.type = 'text';
        verbInput.value =
          savedDecision?.verbReplacement || c.verb.replacement;
        verbRow.append(vl, verbInput);
        verbBox.appendChild(verbRow);

        dialog.appendChild(verbBox);
      } else if (c.needsVerbReview) {
        const warning = document.createElement('div');
        warning.className = 'gl-warn';
        warning.textContent =
          'Check subject–verb agreement manually after accepting this suggestion. A CardMirror comment will be added to this pronoun as a reminder.';
        dialog.appendChild(warning);
      }

      const note = document.createElement('div');
      note.className = 'gl-note';
      note.textContent = `Accepted edit will appear as: ${c.original} [${input.value}] with the original word struck through.`;
      input.addEventListener('input', () => {
        note.textContent = `Accepted edit will appear as: ${c.original} [${input.value}] with the original word struck through.`;
      });
      dialog.appendChild(note);

      const actions = document.createElement('div');
      actions.className = 'gl-actions';

      const stop = document.createElement('button');
      stop.className = 'gl-stop';
      stop.textContent = 'Stop';
      stop.title = 'Stop reviewing and go to the Apply/Discard screen';

      const back = document.createElement('button');
      back.textContent = 'Back';
      back.disabled = index === 0;

      const skip = document.createElement('button');
      skip.textContent = 'Skip';

      const accept = document.createElement('button');
      accept.className = 'gl-primary';
      accept.textContent = savedDecision ? 'Update' : 'Accept';

      actions.append(stop, back, skip, accept);
      dialog.appendChild(actions);

      stop.addEventListener('click', () => {
        index = candidates.length;
        void render();
      });

      back.addEventListener('click', () => {
        if (index <= 0) return;
        index--;
        void render();
      });

      skip.addEventListener('click', () => {
        decisions.delete(index);
        index++;
        void render();
      });

      accept.addEventListener('click', () => {
        const replacement = input.value.trim();
        if (!replacement) {
          toast('Enter a replacement or choose Skip.');
          return;
        }

        const applyVerb = !!(c.verb && verbCheck?.checked);
        decisions.set(index, {
          candidate: c,
          replacement,
          applyVerb,
          verbReplacement: c.verb
            ? (verbInput?.value.trim() || c.verb.replacement)
            : '',
          addVerbReviewComment:
            /^(he|she)$/i.test(c.original) &&
            (c.needsVerbReview || (!!c.verb && !applyVerb)),
        });

        index++;
        void render();
      });
    }

    await render();
  }

  function launchFromRibbon(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();

    const prepared = bestReviewContext();
    if (!prepared) {
      toast('Select text to review, or place the cursor inside a card.');
      return;
    }

    void startReview(prepared);
  }

  function mountUi() {
    ensureStyles();
    if (document.getElementById(PANEL_ID)) {
      mounted = true;
      return true;
    }

    const custom = document.getElementById('custom-ribbon-panel');
    const parent = custom?.parentElement;
    if (!custom || !parent) return false;

    const wrap = document.createElement('div');
    wrap.id = PANEL_ID;
    wrap.className = 'ribbon-doc-ops-panel';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Gendered Pronoun Review');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ribbon-doc-ops-btn gl-ribbon-btn';
    btn.innerHTML =
      '<span class="gl-ribbon-label"><span>Gendered Pronoun</span> <span>Review</span></span>';
    btn.title = 'Review gendered pronouns in the selection or current card';

    // Do the real launch on pointerdown so CardMirror cannot erase the editor
    // selection before we determine whether to scan the selection or card.
    btn.addEventListener('pointerdown', launchFromRibbon);

    // Keyboard-accessible fallback. Mouse/pointer clicks are already handled
    // above, so ignore click events whose detail indicates a pointer click.
    btn.addEventListener('click', event => {
      if (event.detail !== 0) return;
      launchFromRibbon(event);
    });

    wrap.appendChild(btn);

    // Keep feature groups independent. Prefer the end of our current feature
    // chain so this doesn't overlap Round Report / Smart Doc / Keyword Finder.
    const smart = document.getElementById('cardmirror-smart-doc-panel');
    const keyword = document.getElementById('cardmirror-keyword-finder-panel');
    const anchor = smart?.parentElement === parent ? smart :
                   keyword?.parentElement === parent ? keyword : custom;
    anchor.insertAdjacentElement('afterend', wrap);

    mounted = true;
    return true;
  }

  function maintainUi() {
    if (!document.getElementById(PANEL_ID)) mounted = false;
    if (!mounted) mountUi();
  }

  const def = {
    id: PLUGIN_ID,
    name: 'Gendered Pronoun Review',
    apiVersion: 1,
    commands: [
      {
        id: PLUGIN_ID + '.review',
        label: 'Gendered Pronoun Review: Review Pronouns',
        keywords: ['pronoun', 'gender', 'neutral', 'language', 'they'],
        defaultKey: null,
        run: api => {
          pluginApi = api;
          void startReview(bestReviewContext());
        },
      },
    ],
    settings: [],
  };

  try {
    window.__registerCardMirrorPlugin?.(def);
  } catch (err) {
    console.error('[Gendered Pronoun Review] registration failed:', err);
  }

  document.addEventListener('focusin', e => {
    const r = e.target?.closest?.('.ProseMirror');
    if (r) {
      lastFocusedRoot = r;
      setTimeout(captureLiveReviewContext, 0);
    }
  }, true);

  document.addEventListener('mousedown', e => {
    const r = e.target?.closest?.('.ProseMirror');
    if (r) {
      lastFocusedRoot = r;
      // Capture after CardMirror places the caret/selection.
      setTimeout(captureLiveReviewContext, 0);
    }
  }, true);

  document.addEventListener('mouseup', captureLiveReviewContext, true);
  document.addEventListener('keyup', captureLiveReviewContext, true);
  document.addEventListener('selectionchange', captureLiveReviewContext, true);
  document.addEventListener('input', () => {
    setTimeout(captureLiveReviewContext, 0);
  }, true);

  // Seed the cache if the editor already has a caret when the plugin loads.
  setTimeout(captureLiveReviewContext, 0);

  // The ribbon can be rebuilt by CardMirror. This observer only checks whether
  // our tiny ribbon section still exists; it never scans/reprocesses the editor.
  const observer = new MutationObserver(() => maintainUi());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  maintainUi();
})();