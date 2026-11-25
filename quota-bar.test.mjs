import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  PLUGIN_MARKER_END,
  PLUGIN_MARKER_START,
  getPluginStatus,
  installPlugin,
  uninstallPlugin,
} from './install.mjs';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const JS_PATH = join(PLUGIN_DIR, 'quota-bar.js');
const CSS_PATH = join(PLUGIN_DIR, 'quota-bar.css');

function loadLogicHelpers() {
  const src = readFileSync(JS_PATH, 'utf8');
  const start = '/* QUOTA_BAR_LOGIC_START */';
  const end = '/* QUOTA_BAR_LOGIC_END */';
  const s = src.indexOf(start);
  const e = src.indexOf(end);
  assert.ok(s !== -1 && e > s, 'QUOTA_BAR_LOGIC markers missing');
  const block = src.slice(s + start.length, e);
  const factory = new Function(
    `${block}\nreturn {
      normalizeQuotaBarStyleValue,
      normalizeQuotaBarClickValue,
      normalizeQuotaBarReset5hValue,
      readBucketRemainingFraction,
      readResetSec,
      calcRemainingPct,
      levelOfRemaining,
      formatCompactCountdown,
      formatSpacedCountdown,
      formatResetCountdown,
      formatShortGroupName,
      getBucketByWindow,
      findGlobalGroup,
      matchGroupForModel,
      formatSidebarResetStatus,
      maskEmail,
      normalizeAccountInfo,
      normalizeGroupsForCache,
      detectTurnFinishedSignal,
      resolveCompactRingModel,
      encodePrefsCookieValue,
      parsePrefsCookieString,
      mergeStoredPrefs
    };`,
  );
  return factory();
}

function checkCssBraces(css) {
  let depth = 0;
  let inComment = false;
  let inStr = null;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    const next = css[i + 1];
    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        i += 1;
      }
      continue;
    }
    if (inStr) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      inComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      assert.ok(depth >= 0, `Unmatched closing brace at offset ${i}`);
    }
  }
  assert.equal(inComment, false, 'Unclosed CSS comment');
  assert.equal(depth, 0, `Unclosed CSS brace depth=${depth}`);
}

test('quota-bar.js compiles in new Function(ctx, boot) sandbox and uses 0 MutationObserver', () => {
  const src = readFileSync(JS_PATH, 'utf8');
  const codeNoComments = src.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(codeNoComments, /\bMutationObserver\b/, 'quota-bar.js must not use MutationObserver');
  assert.doesNotMatch(codeNoComments, /isGenerating\s*===/, 'legacy payload.isGenerating check must be removed');
  assert.match(src, /window\.__agQuotaBarHooks/, 'extension hooks must be exposed');
  assert.doesNotThrow(() => new Function('ctx', 'boot', src));
  assert.doesNotThrow(() => new vm.Script(src));
});

test('quota-bar.css has balanced braces and covers all 5 upstream presets', () => {
  const css = readFileSync(CSS_PATH, 'utf8');
  checkCssBraces(css);
  for (const needle of [
    '--ag-qb-card-bg',
    'data-ag-preset="absolutely"',
    'data-ag-preset="native"',
    'data-ag-dark-preset="claude-warm"',
    '#ag-sidebar-quota-wrap',
    '#ag-titlebar-quota-pill',
    '#ag-quota-tooltip',
    '[data-ag-qb-reset5h-switch="1"]',
  ]) {
    assert.ok(css.includes(needle), `Expected CSS selector/token: ${needle}`);
  }
});

test('quota logic helpers handle percentages, pool matching, dual countdowns, and PII-free cache normalization', () => {
  const h = loadLogicHelpers();

  assert.equal(h.calcRemainingPct(0.843, false), 84);
  assert.equal(h.calcRemainingPct(0.843, true), '84.3%');
  assert.equal(h.levelOfRemaining(26), 'ok');
  assert.equal(h.levelOfRemaining(25), 'warn');
  assert.equal(h.levelOfRemaining(11), 'warn');
  assert.equal(h.levelOfRemaining(10), 'crit');

  const groups = [
    {
      displayName: 'Gemini Models',
      description: 'Gemini 4',
      buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', remaining: { case: 'remainingFraction', value: 0.72 }, resetTime: { seconds: 2000000 } },
        { bucketId: 'gemini-5h', window: '5h', remaining: { case: 'remainingFraction', value: 0.2 }, resetTime: { seconds: 1007200 } },
      ],
    },
    {
      displayName: 'Claude / GPT',
      description: 'Claude Sonnet 4.5, GPT-OSS',
      buckets: [
        { bucketId: '3p-weekly', window: 'weekly', remaining: { case: 'remainingFraction', value: 0.91 }, resetTime: { seconds: 2000000 } },
      ],
    },
  ];
  const globalG = h.findGlobalGroup(groups);
  assert.equal(globalG.displayName, 'Gemini Models');
  assert.equal(h.matchGroupForModel(groups, 'Claude Sonnet 4.5', globalG).displayName, 'Claude / GPT');
  assert.equal(h.matchGroupForModel(groups, 'Gemini 4 Argon', globalG).displayName, 'Gemini Models');

  // Auto-switch countdown to 5h when 5h <= 25% and weekly > 25%
  const auto5h = h.formatSidebarResetStatus({
    remWeekly: 72,
    resetWeeklySec: 1000 + 3 * 86400,
    rem5h: 25,
    reset5hSec: 1000 + 3600,
    prefer5h: false,
    nowMs: 1000 * 1000,
    hasData: true,
    isZh: true,
  });
  assert.match(auto5h.text, /^5h限额/);
  assert.equal(auto5h.level, 'warn');

  // Dual countdown when prefer5h=true
  const dual = h.formatSidebarResetStatus({
    remWeekly: 72,
    resetWeeklySec: 1000 + 3 * 86400,
    rem5h: 88,
    reset5hSec: 1000 + 5400,
    prefer5h: true,
    nowMs: 1000 * 1000,
    hasData: true,
    isZh: true,
  });
  assert.match(dual.text, /^周限额/);
  assert.match(dual.secondaryText, /^5h限额/);

  // PII masking and normalized cache shape
  const acct = h.normalizeAccountInfo({ email: 'alice.smith@example.com', userTier: { name: 'Google AI Ultra' } });
  assert.deepEqual(acct, { maskedEmail: 'al***@example.com', tierLabel: 'Ultra' });

  const normGroups = h.normalizeGroupsForCache(groups);
  assert.equal(normGroups[0].buckets[0].remainingFraction, 0.72);
  assert.equal(normGroups[0].buckets[0].resetSec, 2000000);
});

test('review fix #1: detectTurnFinishedSignal fires on cancel button removal and metrics sig change', () => {
  const h = loadLogicHelpers();

  // Initial observation: no spurious trigger
  let s = { wasCancelBtnVisible: false, lastMetricsSig: null };
  let r = h.detectTurnFinishedSignal(s, { hasCancelBtn: false, metricsSig: 'sig-1' });
  assert.equal(r.triggered, false);
  s = r.nextState;

  // Generating starts
  r = h.detectTurnFinishedSignal(s, { hasCancelBtn: true, metricsSig: 'sig-1' });
  assert.equal(r.triggered, false);
  s = r.nextState;

  // Cancel button removed -> turn finished
  r = h.detectTurnFinishedSignal(s, { hasCancelBtn: false, metricsSig: 'sig-1' });
  assert.equal(r.triggered, true);
  s = r.nextState;

  // Metrics sig changes -> turn finished
  r = h.detectTurnFinishedSignal(s, { hasCancelBtn: false, metricsSig: 'sig-2' });
  assert.equal(r.triggered, true);
});

test('review fixes #2, #3, #4: multi-window storage sync throttle, session account meta cache, and decoupled Fiber cache', async () => {
  const src = readFileSync(JS_PATH, 'utf8');
  // Check source implementation markers for the 4 fixes
  assert.match(src, /lastFetchMs = Math\.max\(lastFetchMs, syncedAtMs\)/, 'handleStorageSync must update lastFetchMs');
  assert.match(src, /accountMetaResolved && cachedAccountMeta/, 'resolveAccountMetadata must cache per session');
  assert.match(src, /cachedServices\?\.cloudCodeService && \(cachedServices\.authService \|\| fiberAuthScanDone\)/, 'findFrontendServices must cache without authService');

  // Behavioral simulation in vm sandbox
  let quotaCalls = 0;
  let userStatusCalls = 0;
  let authChangeCb = null;
  const storageMap = new Map();
  const windowListeners = new Map();
  const intervals = [];

  const mockCloudCodeService = {
    async retrieveUserQuotaSummary() {
      quotaCalls += 1;
      return {
        response: {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                { bucketId: 'gemini-weekly', window: 'weekly', remaining: { case: 'remainingFraction', value: 0.8 }, resetTime: { seconds: Math.floor(Date.now() / 1000) + 3600 } },
                { bucketId: 'gemini-5h', window: '5h', remaining: { case: 'remainingFraction', value: 0.9 }, resetTime: { seconds: Math.floor(Date.now() / 1000) + 1800 } },
              ],
            },
          ],
        },
      };
    },
  };
  const mockAuthService = {
    _lsClient: {
      async getUserStatus() {
        userStatusCalls += 1;
        return { userStatus: { email: 'dev@example.com', userTier: { name: 'Pro' } } };
      },
    },
    onDidChangeLoginSession(cb) {
      authChangeCb = cb;
      return { dispose() {} };
    },
  };

  const makeEl = (tag = 'div') => ({
    tagName: tag.toUpperCase(),
    nodeType: 1,
    style: {},
    attrs: new Map(),
    children: [],
    className: '',
    textContent: '',
    setAttribute(k, v) {
      this.attrs.set(k, String(v));
    },
    getAttribute(k) {
      return this.attrs.has(k) ? this.attrs.get(k) : null;
    },
    hasAttribute(k) {
      return this.attrs.has(k);
    },
    removeAttribute(k) {
      this.attrs.delete(k);
    },
    appendChild(c) {
      c.parentElement = this;
      this.children.push(c);
      return c;
    },
    insertBefore(c) {
      c.parentElement = this;
      this.children.push(c);
      return c;
    },
    replaceChildren() {
      this.children = [];
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 200, height: 30, left: 0, top: 0, right: 200, bottom: 30 };
    },
    remove() {},
  });

  const rootEl = makeEl('div');
  rootEl.id = 'root';
  // Provide cloudCodeService + authService on React fiber root
  rootEl['__reactContainer$test'] = {
    current: {
      memoizedProps: { value: { core: { cloudCodeService: mockCloudCodeService, authService: mockAuthService } } },
    },
  };

  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    WeakSet,
    Map,
    Set,
    Element: class Element {},
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    setInterval(fn, ms) {
      const id = intervals.length + 1;
      intervals.push({ id, fn, ms });
      return id;
    },
    clearInterval() {},
    document: {
      hidden: false,
      visibilityState: 'visible',
      documentElement: makeEl('html'),
      body: makeEl('body'),
      getElementById(id) {
        return id === 'root' ? rootEl : null;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      createElement: makeEl,
      createElementNS: (_ns, tag) => makeEl(tag),
      addEventListener() {},
      removeEventListener() {},
    },
    window: null,
  };
  sandbox.window = {
    location: { protocol: 'vscode-file:' },
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
    },
    addEventListener(ev, fn) {
      if (!windowListeners.has(ev)) windowListeners.set(ev, []);
      windowListeners.get(ev).push(fn);
    },
    removeEventListener() {},
  };
  sandbox.window.top = sandbox.window;

  const cleanups = [];
  const ctx = {
    config: { enabled: true },
    modules: { metrics: false, quotaBar: true, tokenAnalytics: true },
    onCleanup: (fn) => cleanups.push(fn),
  };

  const compiled = vm.runInNewContext(`(function(ctx, boot) {\n${src}\n})`, sandbox);
  compiled(ctx, ctx);

  // Wait for initial async fetchQuota to finish
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(quotaCalls, 1, 'initial quota fetch should run even when modules.metrics is false');
  assert.equal(userStatusCalls, 1, 'initial account metadata should be queried once');

  // Simulate another window updating localStorage right now -> storage event should throttle our 60s poll
  const freshUpdatedSec = Math.floor(Date.now() / 1000) + 1;
  storageMap.set(
    'ag-quota-cache-v1',
    JSON.stringify({
      v: 1,
      updatedAtSec: freshUpdatedSec,
      account: { maskedEmail: 'de***@example.com', tierLabel: 'Pro' },
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.75, resetSec: freshUpdatedSec + 3600 }],
        },
      ],
    }),
  );
  for (const fn of windowListeners.get('storage') || []) {
    fn({ key: 'ag-quota-cache-v1', newValue: storageMap.get('ag-quota-cache-v1') });
  }
  const poll60s = intervals.find((i) => i.ms === 60000);
  assert.ok(poll60s, '60s poll interval should exist');
  poll60s.fn();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(quotaCalls, 1, '60s poll must skip fetch when another window just synced');

  // Trigger auth session change -> clears account cache and re-fetches both quota & userStatus
  assert.equal(typeof authChangeCb, 'function');
  authChangeCb();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(quotaCalls, 2);
  assert.equal(userStatusCalls, 2, 'account metadata cache must reset on auth change');

  // Cleanup
  for (const c of cleanups) c();
});

test('install.mjs idempotently installs, preserves existing user code, reports status, and uninstalls cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-qb-plugin-'));
  try {
    const jsPath = join(dir, 'custom.js');
    const cssPath = join(dir, 'custom.css');
    const userJs = '// user custom js\nconsole.log("keep me");\n';
    const userCss = '/* user custom css */\n:root { --my-var: 1px; }\n';
    writeFileSync(jsPath, userJs, 'utf8');
    writeFileSync(cssPath, userCss, 'utf8');

    const res1 = installPlugin({ targetDir: dir });
    assert.equal(res1.ok, true);
    assert.equal(res1.jsChanged, true);
    assert.equal(res1.cssChanged, true);

    const installedJs = readFileSync(jsPath, 'utf8');
    const installedCss = readFileSync(cssPath, 'utf8');
    assert.ok(installedJs.includes('console.log("keep me");'));
    assert.ok(installedJs.includes(PLUGIN_MARKER_START) && installedJs.includes(PLUGIN_MARKER_END));
    assert.ok(installedCss.includes('--my-var: 1px;'));
    assert.ok(installedCss.includes(PLUGIN_MARKER_START) && installedCss.includes(PLUGIN_MARKER_END));

    // Re-install is idempotent
    const res2 = installPlugin({ targetDir: dir });
    assert.equal(res2.jsChanged, false);
    assert.equal(res2.cssChanged, false);

    const st = getPluginStatus({ targetDir: dir });
    assert.equal(st.jsInstalled, true);
    assert.equal(st.cssInstalled, true);

    const uRes = uninstallPlugin({ targetDir: dir });
    assert.equal(uRes.jsRemoved, true);
    assert.equal(uRes.cssRemoved, true);
    assert.equal(readFileSync(jsPath, 'utf8'), userJs);
    assert.equal(readFileSync(cssPath, 'utf8'), userCss);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compact style: normalization preserves default bar, supports compact, and ring button triggers direct refresh', () => {
  const h = loadLogicHelpers();
  assert.equal(h.normalizeQuotaBarStyleValue(undefined), 'bar');
  assert.equal(h.normalizeQuotaBarStyleValue('bar'), 'bar');
  assert.equal(h.normalizeQuotaBarStyleValue('ring'), 'ring');
  assert.equal(h.normalizeQuotaBarStyleValue('圆环'), 'ring');
  assert.equal(h.normalizeQuotaBarStyleValue('compact'), 'compact');
  assert.equal(h.normalizeQuotaBarStyleValue('极简'), 'compact');
  assert.equal(h.normalizeQuotaBarStyleValue('コンパクト'), 'compact');
  assert.equal(h.normalizeQuotaBarStyleValue('codex'), 'compact');

  const css = readFileSync(CSS_PATH, 'utf8');
  for (const needle of [
    '--ag-qb-compact-outer-ok',
    '--ag-qb-compact-inner-ok',
    '--ag-qb-compact-warn',
    '--ag-qb-compact-crit',
    '.ag-qb-compact-ring-svg',
    '[data-style="compact"]',
    '.ag-qb-compact-ring-btn',
    'var(--ag-sidebar-row-fg, var(--ag-qb-text))',
  ]) {
    assert.ok(css.includes(needle), `Expected compact CSS token/selector: ${needle}`);
  }

  const js = readFileSync(JS_PATH, 'utf8');
  assert.match(js, /styleCompact:\s*'极简'/);
  assert.match(js, /data-ring-slot/);
  assert.match(js, /ag-qb-compact-ring-btn/);

  // Dual buckets (e.g. Pro/Plus with both 5h & weekly) -> dual concentric rings
  const dual = h.resolveCompactRingModel(
    {
      buckets: [
        { window: 'weekly', remainingFraction: 0.98 },
        { window: '5h', remainingFraction: 0.92 },
      ],
    },
    true,
  );
  assert.equal(dual.mode, 'dual');
  assert.equal(dual.outerPct, 92);
  assert.equal(dual.innerPct, 98);
  assert.deepEqual(dual.segments, [
    { key: '5h', pct: 92 },
    { key: '7d', pct: 98 },
  ]);

  // Weekly-only plan (e.g. Ultra without 5h bucket) -> clean single ring
  const weeklyOnly = h.resolveCompactRingModel(
    {
      buckets: [{ window: 'weekly', remainingFraction: 0.87 }],
    },
    true,
  );
  assert.equal(weeklyOnly.mode, 'single');
  assert.equal(weeklyOnly.outerPct, 87);
  assert.equal(weeklyOnly.innerPct, null);
  assert.deepEqual(weeklyOnly.segments, [{ key: '7d', pct: 87 }]);

  // 5h-only plan -> clean single ring
  const fiveOnly = h.resolveCompactRingModel(
    {
      buckets: [{ window: '5h', remainingFraction: 0.64 }],
    },
    false,
  );
  assert.equal(fiveOnly.mode, 'single');
  assert.equal(fiveOnly.outerPct, 64);
  assert.equal(fiveOnly.innerPct, null);
  assert.deepEqual(fiveOnly.segments, [{ key: '5h', pct: 64 }]);

  // Empty -> empty mode
  const empty = h.resolveCompactRingModel(null, true);
  assert.equal(empty.mode, 'empty');
  assert.equal(empty.outerPct, null);
  assert.equal(empty.innerPct, null);
  assert.deepEqual(empty.segments, []);
});

test('compact style behavior: ring click forces direct refresh and mouseenter never unpins pinned tooltip', async () => {
  const src = readFileSync(JS_PATH, 'utf8');
  const fetchCalls = [];
  const storageMap = new Map([
    ['ag-quota-bar-prefs-v1', JSON.stringify({ style: 'compact', click: 'popover', reset5h: false })],
  ]);
  const elementsById = new Map();

  class MockElement {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.nodeType = 1;
      this.style = {};
      this.attrs = new Map();
      this.children = [];
      this.parentElement = null;
      this.className = '';
      this.textContent = '';
      this.listeners = new Map();
      this._id = '';
    }
    get id() {
      return this._id;
    }
    set id(v) {
      if (this._id && elementsById.get(this._id) === this) elementsById.delete(this._id);
      this._id = String(v || '');
      if (this._id) elementsById.set(this._id, this);
    }
    get firstElementChild() {
      return this.children[0] || null;
    }
    get nextElementSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx >= 0 ? this.parentElement.children[idx + 1] || null : null;
    }
    setAttribute(k, v) {
      this.attrs.set(k, String(v));
    }
    getAttribute(k) {
      return this.attrs.has(k) ? this.attrs.get(k) : null;
    }
    hasAttribute(k) {
      return this.attrs.has(k);
    }
    removeAttribute(k) {
      this.attrs.delete(k);
    }
    appendChild(c) {
      if (c.parentElement) {
        const idx = c.parentElement.children.indexOf(c);
        if (idx >= 0) c.parentElement.children.splice(idx, 1);
      }
      c.parentElement = this;
      this.children.push(c);
      return c;
    }
    insertBefore(c, ref) {
      if (c.parentElement) {
        const oldIdx = c.parentElement.children.indexOf(c);
        if (oldIdx >= 0) c.parentElement.children.splice(oldIdx, 1);
      }
      c.parentElement = this;
      const refIdx = ref ? this.children.indexOf(ref) : -1;
      if (refIdx >= 0) this.children.splice(refIdx, 0, c);
      else this.children.push(c);
      return c;
    }
    replaceChildren() {
      for (const ch of this.children) ch.parentElement = null;
      this.children = [];
    }
    remove() {
      if (this.parentElement) {
        const idx = this.parentElement.children.indexOf(this);
        if (idx >= 0) this.parentElement.children.splice(idx, 1);
        this.parentElement = null;
      }
      if (this._id && elementsById.get(this._id) === this) elementsById.delete(this._id);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const arr = this.listeners.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    }
    dispatch(type, ev = {}) {
      const event = {
        type,
        target: ev.target || this,
        defaultPrevented: false,
        stopped: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          this.stopped = true;
        },
        ...ev,
      };
      let cur = this;
      while (cur && !event.stopped) {
        for (const fn of cur.listeners.get(type) || []) {
          fn(event);
        }
        cur = type === 'mouseenter' || type === 'mouseleave' ? null : cur.parentElement;
      }
      return event;
    }
    matchesClass(cls) {
      return String(this.className || '')
        .split(/\s+/)
        .includes(cls);
    }
    closest(sel) {
      const parts = String(sel || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      let cur = this;
      while (cur) {
        for (const p of parts) {
          if (p.startsWith('.') && cur.matchesClass(p.slice(1))) return cur;
          if (p.startsWith('#') && cur.id === p.slice(1)) return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    }
    querySelector(sel) {
      for (const ch of this.children) {
        if (sel.startsWith('.') && ch.matchesClass(sel.slice(1))) return ch;
        if (sel.startsWith('#') && ch.id === sel.slice(1)) return ch;
        if (sel === 'svg' && ch.tagName === 'SVG') return ch;
        const found = ch.querySelector(sel);
        if (found) return found;
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      for (const ch of this.children) {
        if (sel === 'span' && ch.tagName === 'SPAN') out.push(ch);
        else if (sel.startsWith('.') && ch.matchesClass(sel.slice(1))) out.push(ch);
        out.push(...ch.querySelectorAll(sel));
      }
      return out;
    }
    getBoundingClientRect() {
      return { width: 240, height: 32, left: 8, top: 600, right: 248, bottom: 632 };
    }
  }

  const rootEl = new MockElement('div');
  rootEl.id = 'root';
  const sidebarParent = new MockElement('div');
  const settingsBtn = new MockElement('button');
  settingsBtn.setAttribute('data-testid', 'settings-button');
  sidebarParent.appendChild(settingsBtn);

  const mockCloudCodeService = {
    async retrieveUserQuotaSummary(force) {
      fetchCalls.push(Boolean(force));
      return {
        response: {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                { bucketId: 'gemini-weekly', window: 'weekly', remaining: { case: 'remainingFraction', value: 0.97 }, resetTime: { seconds: Math.floor(Date.now() / 1000) + 86400 } },
                { bucketId: 'gemini-5h', window: '5h', remaining: { case: 'remainingFraction', value: 0.88 }, resetTime: { seconds: Math.floor(Date.now() / 1000) + 3600 } },
              ],
            },
          ],
        },
      };
    },
  };
  rootEl['__reactContainer$test'] = {
    current: {
      memoizedProps: { value: { core: { cloudCodeService: mockCloudCodeService } } },
    },
  };

  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    WeakSet,
    Map,
    Set,
    Element: MockElement,
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    document: {
      hidden: false,
      visibilityState: 'visible',
      documentElement: new MockElement('html'),
      body: new MockElement('body'),
      getElementById: (id) => elementsById.get(id) || null,
      querySelector: (sel) => (sel === '[data-testid="settings-button"]' ? settingsBtn : null),
      querySelectorAll: () => [],
      createElement: (tag) => new MockElement(tag),
      createElementNS: (_ns, tag) => new MockElement(tag),
      addEventListener() {},
      removeEventListener() {},
    },
    window: null,
  };
  sandbox.window = {
    location: { protocol: 'vscode-file:' },
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
    },
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window.top = sandbox.window;

  const cleanups = [];
  const ctx = {
    config: { enabled: true },
    modules: { metrics: false, quotaBar: true, tokenAnalytics: true },
    onCleanup: (fn) => cleanups.push(fn),
  };

  const compiled = vm.runInNewContext(`(function(ctx, boot) {\n${src}\n})`, sandbox);
  compiled(ctx, ctx);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(fetchCalls, [false], 'initial fetch should run with force=false');

  const sidebarBtn = elementsById.get('ag-sidebar-quota-btn');
  assert.ok(sidebarBtn, 'sidebar quota button should be mounted');
  assert.equal(sidebarBtn.getAttribute('data-style'), 'compact');

  // 1) Clicking the small dual-ring button forces direct refresh without opening tooltip
  const ringBtn = sidebarBtn.querySelector('.ag-qb-compact-ring-btn');
  assert.ok(ringBtn, 'compact dual-ring button should exist');
  ringBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(fetchCalls, [false, true], 'clicking compact ring button must call fetchQuota(true)');
  assert.equal(elementsById.get('ag-quota-tooltip')?.getAttribute('data-open') || null, null, 'ring click must not open tooltip');

  // 2) Hover opens preview (unpinned), click pins, subsequent mouseenter keeps it pinned across mouseleave, second click unpins/closes
  sidebarBtn.dispatch('mouseenter');
  const tooltip = elementsById.get('ag-quota-tooltip');
  assert.equal(tooltip?.getAttribute('data-open'), '1', 'hovering compact row opens preview tooltip');
  assert.equal(sidebarBtn.getAttribute('aria-expanded'), 'false', 'hover preview must remain unpinned');

  sidebarBtn.dispatch('click');
  assert.equal(tooltip?.getAttribute('data-open'), '1', 'clicking compact row keeps tooltip open');
  assert.equal(sidebarBtn.getAttribute('aria-expanded'), 'true', 'clicking compact row pins tooltip');

  // Regression check: moving pointer back over compact row must NOT downgrade pinned state
  sidebarBtn.dispatch('mouseenter');
  assert.equal(sidebarBtn.getAttribute('aria-expanded'), 'true', 'mouseenter must preserve pinned state');
  sidebarBtn.dispatch('mouseleave');
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(tooltip?.getAttribute('data-open'), '1', 'pinned tooltip must stay open after mouseleave');
  assert.equal(sidebarBtn.getAttribute('aria-expanded'), 'true');

  // Clicking again unpins and closes cleanly
  sidebarBtn.dispatch('click');
  assert.equal(tooltip?.getAttribute('data-open'), null, 'second click closes pinned tooltip');
  assert.equal(sidebarBtn.getAttribute('aria-expanded'), 'false');

  for (const c of cleanups) c();
});

test('prefs dual-write persistence: cookie helpers and cross-port restart recovery', async () => {
  const h = loadLogicHelpers();

  const encoded = h.encodePrefsCookieValue({ style: 'compact', click: 'refresh', reset5h: true }, 1764000000);
  assert.equal(encoded, 'compact|refresh|1|1764000000');

  assert.deepEqual(h.parsePrefsCookieString(`foo=bar; ag_qb_prefs=${encoded}; baz=1`), {
    style: 'compact',
    click: 'refresh',
    reset5h: true,
    updatedAt: 1764000000,
  });
  assert.deepEqual(h.parsePrefsCookieString('ag_qb_prefs=ring|settings|0'), {
    style: 'ring',
    click: 'settings',
    reset5h: false,
    updatedAt: 0,
  });
  assert.equal(h.parsePrefsCookieString('ag_qb_prefs=bad|value'), null);
  assert.equal(h.parsePrefsCookieString('ag_qb_prefs=bar|popover|yes|123'), null);
  assert.equal(h.parsePrefsCookieString('ag_qb_prefs=bar|popover|1|abc'), null);

  // Empty localStorage + preserved cookie (restart on new port) -> restores from cookie and backfills localStorage
  const fromCookie = h.mergeStoredPrefs(
    null,
    { style: 'bar', click: 'popover', reset5h: true, updatedAt: 1764000100 },
    { style: 'bar', click: 'popover', reset5h: false },
  );
  assert.equal(fromCookie.source, 'cookie');
  assert.equal(fromCookie.prefs.reset5h, true);
  assert.equal(fromCookie.needsLocalBackfill, true);
  assert.equal(fromCookie.needsCookieBackfill, false);

  // Existing localStorage without cookie -> migrates into cookie
  const fromLocal = h.mergeStoredPrefs(
    { style: 'ring', click: 'popover', reset5h: true },
    null,
    { style: 'bar', click: 'popover', reset5h: false },
  );
  assert.equal(fromLocal.source, 'local');
  assert.equal(fromLocal.prefs.reset5h, true);
  assert.equal(fromLocal.needsCookieBackfill, true);
  assert.equal(fromLocal.needsLocalBackfill, false);

  // Ephemeral port reuse with stale localStorage + newer cookie -> cookie wins
  const newerCookie = h.mergeStoredPrefs(
    { style: 'bar', click: 'popover', reset5h: false, updatedAt: 1764000050 },
    { style: 'compact', click: 'refresh', reset5h: true, updatedAt: 1764000200 },
    { style: 'bar', click: 'popover', reset5h: false },
  );
  assert.equal(newerCookie.source, 'cookie');
  assert.deepEqual(newerCookie.prefs, { style: 'compact', click: 'refresh', reset5h: true });
  assert.equal(newerCookie.needsLocalBackfill, true);

  // End-to-end VM simulation across two ephemeral ports sharing host cookie jar
  const src = readFileSync(JS_PATH, 'utf8');
  const cookieJar = new Map();
  const writtenCookies = [];

  function makeCookieAccessor() {
    return {
      get() {
        return Array.from(cookieJar.entries())
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');
      },
      set(raw) {
        writtenCookies.push(String(raw));
        const first = String(raw || '').split(';')[0] || '';
        const eq = first.indexOf('=');
        if (eq > 0) {
          cookieJar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
        }
      },
    };
  }

  function bootOnPort(port, storageMap) {
    const cleanups = [];
    const makeEl = (tag = 'div') => ({
      tagName: tag.toUpperCase(),
      nodeType: 1,
      style: {},
      attrs: new Map(),
      children: [],
      className: '',
      textContent: '',
      setAttribute(k, v) {
        this.attrs.set(k, String(v));
      },
      getAttribute(k) {
        return this.attrs.has(k) ? this.attrs.get(k) : null;
      },
      hasAttribute(k) {
        return this.attrs.has(k);
      },
      removeAttribute(k) {
        this.attrs.delete(k);
      },
      appendChild(c) {
        c.parentElement = this;
        this.children.push(c);
        return c;
      },
      insertBefore(c) {
        c.parentElement = this;
        this.children.push(c);
        return c;
      },
      replaceChildren() {
        this.children = [];
      },
      addEventListener() {},
      removeEventListener() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      closest() {
        return null;
      },
      getBoundingClientRect() {
        return { width: 200, height: 30, left: 0, top: 0, right: 200, bottom: 30 };
      },
      remove() {},
    });
    const doc = {
      hidden: false,
      visibilityState: 'visible',
      documentElement: makeEl('html'),
      body: makeEl('body'),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: makeEl,
      createElementNS: (_ns, tag) => makeEl(tag),
      addEventListener() {},
      removeEventListener() {},
    };
    Object.defineProperty(doc, 'cookie', makeCookieAccessor());

    const sandbox = {
      console,
      Date,
      Math,
      JSON,
      Number,
      String,
      Boolean,
      Array,
      Object,
      WeakSet,
      Map,
      Set,
      Element: class Element {},
      performance: { now: () => Date.now() },
      setTimeout,
      clearTimeout,
      setInterval: () => 1,
      clearInterval: () => {},
      document: doc,
      window: null,
    };
    sandbox.window = {
      location: { protocol: 'https:', origin: `https://127.0.0.1:${port}` },
      innerWidth: 1280,
      innerHeight: 800,
      localStorage: {
        getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
        setItem: (k, v) => storageMap.set(k, String(v)),
      },
      addEventListener() {},
      removeEventListener() {},
    };
    sandbox.window.top = sandbox.window;

    const ctx = {
      config: { enabled: true },
      modules: { metrics: false, quotaBar: true, tokenAnalytics: true },
      onCleanup: (fn) => cleanups.push(fn),
    };
    const compiled = vm.runInNewContext(`(function(ctx, boot) {\n${src}\n})`, sandbox);
    compiled(ctx, ctx);
    return { window: sandbox.window, cleanup: () => cleanups.forEach((fn) => fn()) };
  }

  // Session 1 on port 55047: user checks "also show 5h countdown" and selects compact style
  const port1Storage = new Map();
  const s1 = bootOnPort(55047, port1Storage);
  s1.window.__ag_set_quota_prefs_fn({ style: 'compact', reset5h: true }, true);
  assert.equal(s1.window.__ag_quota_bar_reset_5h, true);
  assert.equal(s1.window.__ag_quota_bar_style, 'compact');
  assert.ok(writtenCookies.some((c) => /ag_qb_prefs=compact\|popover\|1\|\d+/.test(c)));
  assert.ok(writtenCookies.some((c) => c.includes('Path=/') && c.includes('Max-Age=31536000') && c.includes('SameSite=Lax') && c.includes('Secure')));
  s1.cleanup();

  // Session 2 after APP restart on fresh port 61234 with empty localStorage but shared cookie jar
  const port2Storage = new Map();
  const s2 = bootOnPort(61234, port2Storage);
  assert.equal(s2.window.__ag_quota_bar_reset_5h, true, 'reset5h must survive port change via cookie');
  assert.equal(s2.window.__ag_quota_bar_style, 'compact', 'style must survive port change via cookie');
  const hydrated = JSON.parse(port2Storage.get('ag-quota-bar-prefs-v1') || '{}');
  assert.equal(hydrated.reset5h, true);
  assert.equal(hydrated.style, 'compact');
  s2.cleanup();
});
