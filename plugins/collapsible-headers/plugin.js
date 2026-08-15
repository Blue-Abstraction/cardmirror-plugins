(() => {
  'use strict';

  const PLUGIN_ID = 'cardmirror-collapsible-headers';
  const STYLE_ID = 'cardmirror-collapsible-headers-style';
  const LAYER_ID = 'cardmirror-collapsible-headers-layer';
  const HEADING_SELECTOR =
    '.ProseMirror > .pmd-pocket, .ProseMirror > .pmd-hat, .ProseMirror > .pmd-block';

  const collapsedIds = new Set();
  const buttons = new Map();

  let refreshQueued = false;
  let layoutQueued = false;
  let layer = null;
  let collapseStyle = null;

  function headingLevel(el) {
    if (!(el instanceof HTMLElement)) return null;
    if (el.classList.contains('pmd-pocket')) return 1;
    if (el.classList.contains('pmd-hat')) return 2;
    if (el.classList.contains('pmd-block')) return 3;
    return null;
  }

  function headingId(el) {
    return el instanceof HTMLElement ? (el.getAttribute('data-id') || '').trim() : '';
  }

  function ensureUi() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        #${LAYER_ID} {
          position: fixed;
          inset: 0;
          z-index: 2147483000;
          pointer-events: none;
        }

        #${LAYER_ID} .cm-collapse-toggle {
          position: fixed;
          width: 15px;
          height: 15px;
          padding: 0;
          margin: 0;
          border: 0;
          background: transparent;
          color: currentColor;
          opacity: .62;
          pointer-events: auto;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: system-ui, sans-serif;
          font-size: 8px;
          font-weight: 800;
          line-height: 1;
          border-radius: 3px;
          user-select: none;
          -webkit-user-select: none;
        }

        #${LAYER_ID} .cm-collapse-toggle:hover {
          opacity: 1;
          background: color-mix(in srgb, currentColor 10%, transparent);
        }

        #${LAYER_ID} .cm-collapse-toggle:focus-visible {
          outline: 1px solid currentColor;
          outline-offset: 1px;
        }
      `;
      document.head.appendChild(style);
    }

    layer = document.getElementById(LAYER_ID);
    if (!layer) {
      layer = document.createElement('div');
      layer.id = LAYER_ID;
      document.body.appendChild(layer);
    }

    collapseStyle = document.getElementById('cardmirror-collapsible-headers-rules');
    if (!collapseStyle) {
      collapseStyle = document.createElement('style');
      collapseStyle.id = 'cardmirror-collapsible-headers-rules';
      document.head.appendChild(collapseStyle);
    }
  }

  function cssString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function allHeadings() {
    return Array.from(document.querySelectorAll(HEADING_SELECTOR))
      .filter(el => el instanceof HTMLElement);
  }

  function sectionBounds(heading) {
    const root = heading?.parentElement;
    const level = headingLevel(heading);
    if (!(root instanceof HTMLElement) ||
        !root.classList.contains('ProseMirror') ||
        level == null) return null;

    const children = Array.from(root.children).filter(el => el instanceof HTMLElement);
    const startIndex = children.indexOf(heading);
    if (startIndex < 0) return null;

    let endIndexExclusive = children.length;
    for (let i = startIndex + 1; i < children.length; i++) {
      const nextLevel = headingLevel(children[i]);
      if (nextLevel != null && nextLevel <= level) {
        endIndexExclusive = i;
        break;
      }
    }

    return { root, children, startIndex, endIndexExclusive };
  }

  function rebuildCollapseCss() {
    const rules = [];

    for (const id of collapsedIds) {
      const escapedId = cssString(id);
      const heading = document.querySelector(
        `.ProseMirror > .pmd-pocket[data-id="${escapedId}"],` +
        `.ProseMirror > .pmd-hat[data-id="${escapedId}"],` +
        `.ProseMirror > .pmd-block[data-id="${escapedId}"]`
      );
      if (!(heading instanceof HTMLElement)) continue;

      const bounds = sectionBounds(heading);
      if (!bounds) continue;
      if (bounds.endIndexExclusive <= bounds.startIndex + 1) continue;

      const firstHidden = bounds.startIndex + 2;
      const lastHidden = bounds.endIndexExclusive;

      rules.push(
        `.ProseMirror:has(> [data-id="${escapedId}"]) ` +
        `> :nth-child(n+${firstHidden}):nth-child(-n+${lastHidden})` +
        `{display:none !important;}`
      );
    }

    collapseStyle.textContent = rules.join('\n');
  }

  function firstTextRect(heading) {
    const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();

    while (node) {
      if ((node.nodeValue || '').trim()) {
        try {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = Array.from(range.getClientRects())
            .filter(r => r.width > 0 && r.height > 0);
          range.detach?.();
          if (rects.length) return rects[0];
        } catch (_) {}
      }
      node = walker.nextNode();
    }

    const rect = heading.getBoundingClientRect();
    return {
      left: rect.left + rect.width / 2,
      top: rect.top,
      bottom: rect.bottom,
      width: 0,
      height: rect.height,
    };
  }

  function createButton(heading) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-collapse-toggle';
    btn.tabIndex = -1;

    btn.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();

      const id = headingId(heading);
      if (!id) return;

      if (collapsedIds.has(id)) collapsedIds.delete(id);
      else collapsedIds.add(id);

      rebuildCollapseCss();
      refreshButtons();
      queueLayout();
    });

    return btn;
  }

  function refreshButtons() {
    ensureUi();
    const live = new Set(allHeadings());

    for (const [heading, btn] of buttons) {
      if (!live.has(heading) || !heading.isConnected) {
        btn.remove();
        buttons.delete(heading);
      }
    }

    for (const heading of live) {
      const id = headingId(heading);
      if (!id) continue;

      let btn = buttons.get(heading);
      if (!btn) {
        btn = createButton(heading);
        buttons.set(heading, btn);
        layer.appendChild(btn);
      }

      const collapsed = collapsedIds.has(id);
      btn.textContent = collapsed ? '▶' : '▼';
      btn.title = collapsed ? 'Expand section' : 'Collapse section';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  function layoutButtons() {
    layoutQueued = false;

    for (const [heading, btn] of buttons) {
      if (!heading.isConnected) {
        btn.style.display = 'none';
        continue;
      }

      const headingStyle = getComputedStyle(heading);
      const headingRect = heading.getBoundingClientRect();

      if (
        headingStyle.display === 'none' ||
        headingStyle.visibility === 'hidden' ||
        headingRect.width <= 0 ||
        headingRect.height <= 0 ||
        headingRect.bottom < 0 ||
        headingRect.top > window.innerHeight
      ) {
        btn.style.display = 'none';
        continue;
      }

      const textRect = firstTextRect(heading);

      btn.style.display = 'flex';
      btn.style.left = `${Math.round(textRect.left - 17)}px`;
      btn.style.top = `${Math.round(
        textRect.top + Math.max(0, (textRect.height - 15) / 2)
      )}px`;
      btn.style.color = headingStyle.color;
    }
  }

  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(layoutButtons);
  }

  function refreshAll() {
    refreshQueued = false;
    ensureUi();
    rebuildCollapseCss();
    refreshButtons();
    queueLayout();
  }

  function queueRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(refreshAll);
  }

  function focusedRoot() {
    const active = document.activeElement;
    if (active instanceof Element) {
      const root = active.closest('.ProseMirror');
      if (root instanceof HTMLElement) return root;
    }

    return Array.from(document.querySelectorAll('.ProseMirror'))
      .find(el => {
        if (!(el instanceof HTMLElement)) return false;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return cs.display !== 'none' &&
               cs.visibility !== 'hidden' &&
               r.width > 0 &&
               r.height > 0;
      }) || null;
  }

  function setAllInFocusedRoot(collapsed) {
    const root = focusedRoot();
    if (!(root instanceof HTMLElement)) return;

    for (const heading of Array.from(root.querySelectorAll(
      ':scope > .pmd-pocket, :scope > .pmd-hat, :scope > .pmd-block'
    ))) {
      if (!(heading instanceof HTMLElement)) continue;
      const id = headingId(heading);
      if (!id) continue;
      if (collapsed) collapsedIds.add(id);
      else collapsedIds.delete(id);
    }

    refreshAll();
  }

  const definition = {
    id: PLUGIN_ID,
    name: 'Collapsible Headers',
    apiVersion: 1,
    commands: [
      {
        id: PLUGIN_ID + '.collapse-all',
        label: 'Collapsible Headers: Collapse All',
        keywords: ['collapse', 'headers', 'outline', 'pocket', 'hat', 'block'],
        defaultKey: null,
        run: () => setAllInFocusedRoot(true),
      },
      {
        id: PLUGIN_ID + '.expand-all',
        label: 'Collapsible Headers: Expand All',
        keywords: ['expand', 'headers', 'outline', 'pocket', 'hat', 'block'],
        defaultKey: null,
        run: () => setAllInFocusedRoot(false),
      },
    ],
    settings: [],
  };

  try {
    window.__registerCardMirrorPlugin?.(definition);
  } catch (err) {
    console.error('[Collapsible Headers] registration failed:', err);
  }

  ensureUi();
  refreshAll();

  document.addEventListener('input', queueRefresh, true);
  document.addEventListener('focusin', queueRefresh, true);
  document.addEventListener('scroll', queueLayout, true);
  window.addEventListener('resize', queueLayout, { passive: true });

  for (const delay of [150, 500, 1200, 3000, 7000]) {
    setTimeout(queueRefresh, delay);
  }
})();