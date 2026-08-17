(() => {
  'use strict';

  if (window.__cardMirrorSafeFeatureDockLoaded) return;
  window.__cardMirrorSafeFeatureDockLoaded = true;

  const DOCK_ID = 'cardmirror-safe-feature-dock';
  const BUTTONS_ID = 'cardmirror-safe-feature-buttons';
  const STYLE_ID = 'cardmirror-safe-feature-dock-style';
  const STORAGE_KEY = 'cardmirror-safe-feature-dock-active-v2';

  const FEATURES = [
    {
      id: 'round-report',
      label: 'Round Report',
      shortLabel: 'RR',
      panel: '#cardmirror-round-report-panel',
    },
    {
      id: 'keyword-finder',
      label: 'Keyword Finder',
      shortLabel: 'Keywords',
      panel: '#cardmirror-keyword-finder-panel',
    },
    {
      id: 'smart-doc',
      label: 'Smart Doc',
      shortLabel: 'Smart Doc',
      panel: '#cardmirror-smart-doc-panel',
    },
    {
      id: 'gendered-language-review',
      label: 'Gendered Pronoun Review',
      shortLabel: 'Pronouns',
      panel: '#cardmirror-gendered-language-panel',
    },
  ];

  let activeId = '';

  function installedIds() {
    const configured = Array.isArray(window.__cardMirrorFeatureDockInstalled)
      ? window.__cardMirrorFeatureDockInstalled
      : null;
    return configured ? new Set(configured.map(String)) : null;
  }

  function availableFeatures() {
    const installed = installedIds();
    return FEATURES.filter(feature => {
      if (installed && !installed.has(feature.id)) return false;
      return document.querySelector(feature.panel) instanceof HTMLElement;
    });
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /*
       * Keep the plugins' original nodes in their expected parents, but remove
       * their presentation from CardMirror's measured ribbon width.
       */
      #cardmirror-round-report-panel,
      #cardmirror-keyword-finder-panel,
      #cardmirror-smart-doc-panel,
      #cardmirror-gendered-language-panel {
        display: none !important;
      }

      /*
       * Put the feature strip immediately after CardMirror's final native
       * left-ribbon panel (#custom-ribbon-panel). The original plugin panels
       * remain hidden, so only one compact extension feature group consumes
       * ribbon width at a time.
       */
      #${DOCK_ID} {
        position: static;
        flex: 0 1 auto;
        min-width: 0;
        max-width: 252px;
        margin-left: 4px;
        margin-right: 4px;
        display: flex;
        align-items: center;
        gap: 4px;
        height: calc(var(--ribbon-height, 4rem) - 6px);
        padding: 3px 5px;
        overflow: hidden;
        border-left: 1px solid var(--pmd-c-border-soft);
        border-right: 0;
        border-top: 0;
        border-bottom: 0;
        border-radius: 0;
        background: transparent;
        color: var(--pmd-c-text);
        font: 600 12px/1.1 var(--pmd-ui-font, system-ui, sans-serif);
        box-sizing: border-box;
      }

      #${DOCK_ID}[hidden] {
        display: none !important;
      }

      #ribbon #${DOCK_ID} button {
        flex: 0 0 auto;
        box-sizing: border-box;
        color: var(--pmd-c-text);
        background: var(--pmd-c-bg);
        border-color: var(--pmd-c-border);
      }

      #ribbon #${DOCK_ID} button:hover:not(:disabled) {
        background: var(--pmd-c-hover);
      }

      #ribbon #${DOCK_ID} .cm-safe-dock-arrow {
        width: 25px;
        min-width: 25px;
        height: 46px;
        padding: 0;
        font-size: 18px;
        font-weight: 700;
      }

      #${DOCK_ID}[data-single="true"] .cm-safe-dock-arrow {
        display: none !important;
      }

      #${BUTTONS_ID} {
        min-width: 0;
        max-width: 184px;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 3px;
      }

      #${DOCK_ID}[data-feature="round-report"] #${BUTTONS_ID} {
        display: grid;
        grid-template-columns: repeat(5, 36px);
        grid-template-rows: repeat(2, 27px);
        gap: 2px;
      }

      #ribbon #${DOCK_ID}[data-feature="round-report"] .cm-safe-proxy-button {
        width: 36px;
        min-width: 36px;
        height: 27px;
        padding: 0 3px;
        font-size: 11px;
      }

      #${DOCK_ID}[data-feature="keyword-finder"] #${BUTTONS_ID},
      #${DOCK_ID}[data-feature="smart-doc"] #${BUTTONS_ID} {
        display: grid;
        grid-template-columns: 1fr;
        grid-template-rows: repeat(2, 27px);
        gap: 2px;
        width: 132px;
      }

      #ribbon #${DOCK_ID}[data-feature="keyword-finder"] .cm-safe-proxy-button,
      #ribbon #${DOCK_ID}[data-feature="smart-doc"] .cm-safe-proxy-button {
        width: 132px;
        height: 27px;
        padding: 0 7px;
        font-size: 11px;
      }

      #${DOCK_ID}[data-feature="gendered-language-review"] #${BUTTONS_ID} {
        width: 154px;
      }

      #ribbon #${DOCK_ID}[data-feature="gendered-language-review"] .cm-safe-proxy-button {
        width: 154px;
        min-width: 154px;
        height: 46px;
        padding: 4px 9px;
        white-space: normal;
        line-height: 1.08;
        text-align: center;
        font-size: 11px;
      }

      /* Mirror Round Report's actual selected state visibly in the proxy. */
      #ribbon #${DOCK_ID} .cm-safe-proxy-button.cm-safe-selected {
        background: var(--pmd-c-success) !important;
        color: var(--pmd-c-text-on-accent) !important;
        border-color: var(--pmd-c-success) !important;
      }

      #ribbon #${DOCK_ID} .cm-safe-proxy-button:disabled {
        opacity: .5;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureDock() {
    ensureStyles();

    const ribbon = document.getElementById('ribbon');
    const left = ribbon?.querySelector?.('.ribbon-left');
    const custom = document.getElementById('custom-ribbon-panel');
    if (
      !(ribbon instanceof HTMLElement) ||
      !(left instanceof HTMLElement) ||
      !(custom instanceof HTMLElement) ||
      custom.parentElement !== left
    ) {
      return null;
    }

    let dock = document.getElementById(DOCK_ID);
    if (dock && dock.parentElement !== left) {
      dock.remove();
      dock = null;
    }

    if (!dock) {
      dock = document.createElement('div');
      dock.id = DOCK_ID;
      dock.hidden = true;
      dock.setAttribute('role', 'group');
      dock.setAttribute('aria-label', 'Installed feature controls');

      const prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'cm-safe-dock-arrow';
      prev.textContent = '‹';
      prev.title = 'Previous installed feature';
      prev.setAttribute('aria-label', 'Previous installed feature');

      const buttons = document.createElement('div');
      buttons.id = BUTTONS_ID;

      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'cm-safe-dock-arrow';
      next.textContent = '›';
      next.title = 'Next installed feature';
      next.setAttribute('aria-label', 'Next installed feature');

      for (const button of [prev, next]) {
        button.addEventListener('mousedown', event => event.preventDefault());
      }
      prev.addEventListener('click', () => shift(-1));
      next.addEventListener('click', () => shift(1));

      dock.append(prev, buttons, next);
      custom.insertAdjacentElement('afterend', dock);
    }

    return dock;
  }

  function restoreActive(list) {
    if (activeId && list.some(item => item.id === activeId)) return;

    try {
      const saved = localStorage.getItem(STORAGE_KEY) || '';
      if (list.some(item => item.id === saved)) {
        activeId = saved;
        return;
      }
    } catch (_) {}

    activeId = list[0]?.id || '';
  }

  function saveActive() {
    try { localStorage.setItem(STORAGE_KEY, activeId); } catch (_) {}
  }

  function sourceButtons(feature) {
    const panel = document.querySelector(feature.panel);
    if (!(panel instanceof HTMLElement)) return [];
    return [...panel.querySelectorAll('button')]
      .filter(button => button instanceof HTMLButtonElement);
  }

  function proxyLabel(feature, source, index) {
    // Hidden elements can have empty innerText on Chromium, causing us to fall
    // back to textContent. The Pronoun button uses adjacent spans, whose
    // textContent is "Gendered PronounReview" with no separator.
    if (feature.id === 'gendered-language-review' && index === 0) {
      return 'Gendered Pronoun Review';
    }
    return (
      source.innerText?.trim() ||
      source.getAttribute('aria-label')?.trim() ||
      source.textContent?.trim() ||
      `Action ${index + 1}`
    );
  }

  function mirrorButtonState(proxy, source) {
    proxy.disabled = source.disabled;
    proxy.title =
      source.title ||
      source.getAttribute('aria-label') ||
      source.textContent?.trim() ||
      '';

    if (
      source.classList.contains('rr-selected') ||
      source.getAttribute('aria-pressed') === 'true'
    ) {
      proxy.classList.add('cm-safe-selected');
    }
  }

  function scheduleStateRefreshes() {
    // Round Report's cross-window/localStorage assignment propagation is not
    // necessarily finished in the same task as source.click(). These are
    // finite refreshes, not polling.
    for (const delay of [0, 60, 180, 450]) {
      setTimeout(render, delay);
    }
  }

  function buildButtons(container, feature) {
    container.replaceChildren();

    const originals = sourceButtons(feature);
    for (let index = 0; index < originals.length; index++) {
      const original = originals[index];
      const proxy = document.createElement('button');
      proxy.type = 'button';
      proxy.className = 'cm-safe-proxy-button';
      proxy.textContent = proxyLabel(feature, original, index);
      mirrorButtonState(proxy, original);

      proxy.addEventListener('mousedown', event => event.preventDefault());
      proxy.addEventListener('click', () => {
        const live = sourceButtons(feature)[index];
        if (!(live instanceof HTMLButtonElement)) return;
        live.click();
        scheduleStateRefreshes();
      });

      container.appendChild(proxy);
    }
  }

  function render() {
    const dock = ensureDock();
    if (!dock) return;

    const list = availableFeatures();
    restoreActive(list);

    dock.hidden = list.length === 0;
    dock.dataset.single = String(list.length <= 1);

    if (!list.length) return;

    const active = list.find(item => item.id === activeId) || list[0];
    activeId = active.id;
    dock.dataset.feature = active.id;
    dock.title = `Feature controls: ${active.label}`;

    const buttons = dock.querySelector(`#${BUTTONS_ID}`);
    if (buttons instanceof HTMLElement) buildButtons(buttons, active);
  }

  function shift(delta) {
    const list = availableFeatures();
    if (list.length <= 1) return;

    let index = list.findIndex(item => item.id === activeId);
    if (index < 0) index = 0;

    index = (index + delta + list.length) % list.length;
    activeId = list[index].id;
    saveActive();
    render();
  }

  window.__cardMirrorSafeFeatureDock = {
    refresh: render,
    next: () => shift(1),
    previous: () => shift(-1),
  };

  // No MutationObserver / ResizeObserver / permanent polling. Feature panels
  // normally mount during boot, so perform a bounded set of startup refreshes.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render, { once: true });
  } else {
    render();
  }

  for (const delay of [250, 800, 1800, 3500, 6000]) {
    setTimeout(render, delay);
  }
})();