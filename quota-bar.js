/**
 * ghang-antigravity-local-ui — Standalone user/custom.js plugin (Quota Bar module)
 *
 * Features:
 * - Bottom-left global quota card above Settings (dual rounded bars / side-by-side dual rings,
 *   auto-collapsing to compact dual rings when sidebar width < 110px via ResizeObserver).
 * - Top titlebar independent pool pill (#ag-titlebar-quota-pill) when using Claude / GPT / Argon.
 * - Clickable / hoverable detail popover (#ag-quota-tooltip) with active pool highlight.
 * - Configurable in Settings -> Appearance (Style: Bar/Ring, Click: Details/Refresh/Settings,
 *   5h countdown co-display), persisted via cookie + localStorage dual-write & synced across windows.
 * - Zero core/daemon.mjs edits, zero MutationObserver, full cleanup via ctx.onCleanup.
 * - Optional extension hooks via window.__agQuotaBarHooks.
 */
((ctx) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.top !== window) return;
  if (window.location && String(window.location.protocol || '').startsWith('plugin:')) return;
  if (ctx?.config?.enabled === false) return;
  if (ctx?.modules?.quotaBar === false) return;

  if (typeof window.__ag_teardown_quota_bar_fn === 'function') {
    try {
      window.__ag_teardown_quota_bar_fn();
    } catch (e) {}
  }

  const STORAGE_KEY = 'ag-quota-cache-v1';
  const PREFS_STORAGE_KEY = 'ag-quota-bar-prefs-v1';
  const PREFS_COOKIE_KEY = 'ag_qb_prefs';
  const PREFS_COOKIE_MAX_AGE_SEC = 31536000;
  const SIDEBAR_WRAP_ID = 'ag-sidebar-quota-wrap';
  const SIDEBAR_BTN_ID = 'ag-sidebar-quota-btn';
  const PILL_ID = 'ag-titlebar-quota-pill';
  const TOOLTIP_ID = 'ag-quota-tooltip';
  const COMPACT_WIDTH_PX = 110;
  const POLL_INTERVAL_MS = 60000;
  const STATE_WATCH_INTERVAL_MS = 1500;
  const COLD_BOOT_RETRY_MS = 1500;
  const MAX_COLD_BOOT_RETRIES = 8;

  /* QUOTA_BAR_LOGIC_START */
  function normalizeQuotaBarStyleValue(rawVal) {
    const s = String(rawVal || '').trim().toLowerCase();
    if (s === 'compact' || s === '极简' || s === '極簡' || s === 'コンパクト' || s === 'codex') return 'compact';
    if (s === 'ring' || s === '圆环') return 'ring';
    return 'bar';
  }

  function normalizeQuotaBarClickValue(rawVal) {
    const s = String(rawVal || '').trim().toLowerCase();
    if (s === 'refresh' || s === '刷新') return 'refresh';
    if (s === 'settings' || s === 'models' || s === '设置') return 'settings';
    return 'popover';
  }

  function normalizeQuotaBarReset5hValue(rawVal) {
    if (typeof rawVal === 'boolean') return rawVal;
    const s = String(rawVal ?? '').trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'on';
  }

  function readBucketRemainingFraction(bucket) {
    if (!bucket || typeof bucket !== 'object') return null;
    const rem = bucket.remaining;
    if (rem && typeof rem === 'object') {
      if (rem.case === 'remainingFraction' && typeof rem.value === 'number' && Number.isFinite(rem.value)) {
        return Math.max(0, Math.min(1, rem.value));
      }
      if (rem.case === 'remainingPercent' && typeof rem.value === 'number' && Number.isFinite(rem.value)) {
        return Math.max(0, Math.min(1, rem.value / 100));
      }
      if (rem.case === 'isExhausted' && rem.value) {
        return 0;
      }
      if (typeof rem.value === 'number' && Number.isFinite(rem.value)) {
        return Math.max(0, Math.min(1, rem.value));
      }
    }
    if (typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)) {
      return Math.max(0, Math.min(1, bucket.remainingFraction));
    }
    return null;
  }

  function readResetSec(resetTime) {
    if (!resetTime) return null;
    if (typeof resetTime === 'number' && Number.isFinite(resetTime)) {
      return resetTime > 1e12 ? Math.floor(resetTime / 1000) : Math.floor(resetTime);
    }
    if (typeof resetTime === 'string') {
      const s = resetTime.trim();
      if (!s) return null;
      if (/^\d+$/.test(s)) {
        const n = Number(s);
        return Number.isFinite(n) ? (n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)) : null;
      }
      const ms = Date.parse(s);
      return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
    }
    if (typeof resetTime === 'object') {
      const secs = resetTime.seconds ?? resetTime.resetSec;
      if (secs !== undefined && secs !== null) {
        const n = Number(secs);
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
      }
    }
    return null;
  }

  function calcRemainingPct(remainingFraction, withDecimal = false) {
    if (typeof remainingFraction !== 'number' || !Number.isFinite(remainingFraction)) {
      return withDecimal ? '--' : null;
    }
    const pct = Math.max(0, Math.min(1, remainingFraction)) * 100;
    if (withDecimal) {
      return `${(Math.round(pct * 10) / 10).toFixed(1)}%`;
    }
    return Math.round(pct);
  }

  function levelOfRemaining(pct) {
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'muted';
    if (pct <= 10) return 'crit';
    if (pct <= 25) return 'warn';
    return 'ok';
  }

  function formatCompactCountdown(resetSec, nowMs = Date.now()) {
    if (typeof resetSec !== 'number' || !Number.isFinite(resetSec) || resetSec <= 0) return '';
    const diffSec = Math.max(0, Math.floor(resetSec - nowMs / 1000));
    if (diffSec < 60) return '<1m';
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) return remMins > 0 ? `${hours}h${remMins}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
  }

  function formatSpacedCountdown(resetSec, nowMs = Date.now(), isZh = true) {
    if (typeof resetSec !== 'number' || !Number.isFinite(resetSec) || resetSec <= 0) return '';
    const diffSec = Math.max(0, Math.floor(resetSec - nowMs / 1000));
    if (diffSec < 60) return isZh ? '<1min' : '<1m';
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return isZh ? `${mins}min` : `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) {
      if (isZh) return remMins > 0 ? `${hours}h ${remMins}min` : `${hours}h`;
      return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    if (isZh) return remHours > 0 ? `${days}天 ${remHours}h` : `${days}天`;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }

  function formatResetCountdown(resetSec, nowMs = Date.now(), isZh = true) {
    if (typeof resetSec !== 'number' || !Number.isFinite(resetSec) || resetSec <= 0) return '';
    const diffSec = Math.max(0, Math.floor(resetSec - nowMs / 1000));
    if (diffSec < 60) return isZh ? '<1分钟' : '<1m';
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return isZh ? `${mins}分钟` : `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) {
      if (isZh) return remMins > 0 ? `${hours}小时${remMins}分` : `${hours}小时`;
      return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    if (isZh) return remHours > 0 ? `${days}天${remHours}小时` : `${days}天`;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }

  function formatShortGroupName(displayName) {
    const s = String(displayName || '').trim();
    if (!s) return 'Quota';
    const low = s.toLowerCase();
    if (low.includes('argon')) return 'Argon';
    if (low.includes('claude') && low.includes('gpt')) return 'Claude / GPT';
    if (low.includes('claude')) return 'Claude';
    if (low.includes('gpt')) return 'GPT';
    if (low.includes('gemini')) return 'Gemini';
    return s.length > 18 ? s.slice(0, 18) : s;
  }

  function getBucketByWindow(group, targetWindow) {
    if (!group || !Array.isArray(group.buckets)) return null;
    const win = String(targetWindow || '').toLowerCase();
    const exact = group.buckets.find((b) => String(b?.window || '').toLowerCase() === win);
    if (exact) return exact;
    if (win === 'weekly') {
      return (
        group.buckets.find((b) => /weekly|7d|week/i.test(`${b?.bucketId || ''} ${b?.displayName || ''}`)) || null
      );
    }
    if (win === '5h') {
      return (
        group.buckets.find((b) => /5h|five.?hour|5.?hour/i.test(`${b?.bucketId || ''} ${b?.displayName || ''}`)) ||
        null
      );
    }
    return null;
  }

  function findGlobalGroup(groups) {
    if (!Array.isArray(groups) || groups.length === 0) return null;
    const geminiGroup = groups.find((g) => {
      const name = String(g?.displayName || '').toLowerCase();
      if (name.includes('argon')) return false;
      if (name.includes('gemini')) return true;
      return Array.isArray(g?.buckets) && g.buckets.some((b) => /^gemini-(weekly|5h)$/i.test(String(b?.bucketId || '')));
    });
    return geminiGroup || groups[0];
  }

  function matchGroupForModel(groups, modelName, globalGroup) {
    const fallback = globalGroup || findGlobalGroup(groups);
    if (!Array.isArray(groups) || groups.length === 0) return null;
    const raw = String(modelName || '').trim();
    if (!raw) return fallback;
    const low = raw.toLowerCase();

    if (low.includes('argon')) {
      const argonGroup = groups.find((g) => String(g?.displayName || '').toLowerCase().includes('argon'));
      return argonGroup || fallback;
    }
    if (
      low.includes('claude') ||
      low.includes('opus') ||
      low.includes('sonnet') ||
      low.includes('haiku') ||
      low.includes('gpt') ||
      low.includes('oss')
    ) {
      const thirdParty = groups.find((g) => {
        if (g === fallback) return false;
        const hay = `${g?.displayName || ''} ${g?.description || ''}`.toLowerCase();
        return hay.includes('claude') || hay.includes('gpt') || hay.includes('oss');
      });
      if (thirdParty) return thirdParty;
    }

    const directMatch = groups.find((g) => {
      if (g === fallback) return false;
      const desc = String(g?.description || '').toLowerCase();
      const name = String(g?.displayName || '').toLowerCase();
      return (desc && desc.includes(low)) || (name && low.includes(name));
    });
    if (directMatch) return directMatch;

    return fallback;
  }

  function formatSidebarResetStatus(opts = {}) {
    const {
      remWeekly = null,
      resetWeeklySec = null,
      rem5h = null,
      reset5hSec = null,
      prefer5h = false,
      nowMs = Date.now(),
      isLoading = false,
      hasError = false,
      hasData = false,
      isZh = true
    } = opts;
    if (!hasData) {
      if (isLoading) {
        return { text: isZh ? '正在同步配额…' : 'Syncing quota...', level: 'muted' };
      }
      if (hasError) {
        return { text: isZh ? '点击重试获取配额' : 'Click to retry quota', level: 'muted' };
      }
      return { text: isZh ? '周限额待同步' : 'Weekly pending sync', level: 'muted' };
    }

    const has5h = typeof rem5h === 'number' && Number.isFinite(rem5h);
    const hasWeekly = typeof remWeekly === 'number' && Number.isFinite(remWeekly);
    const fiveHLvl = levelOfRemaining(rem5h);
    const weeklyLvl = levelOfRemaining(remWeekly);

    if (prefer5h && (hasWeekly || resetWeeklySec) && (has5h || reset5hSec)) {
      const cdW = formatSpacedCountdown(resetWeeklySec, nowMs, isZh);
      const cd5h = formatSpacedCountdown(reset5hSec, nowMs, isZh);
      return {
        text: cdW
          ? isZh
            ? `周限额 ${cdW}后重置`
            : `Weekly ${cdW}`
          : isZh
            ? '周限额已重置'
            : 'Weekly reset',
        level: weeklyLvl === 'ok' ? 'muted' : weeklyLvl,
        secondaryText: cd5h
          ? isZh
            ? `5h限额 ${cd5h}后重置`
            : `5h ${cd5h}`
          : isZh
            ? '5h限额已重置'
            : '5h reset',
        secondaryLevel: fiveHLvl === 'ok' ? 'muted' : fiveHLvl
      };
    }

    if (prefer5h && (has5h || reset5hSec)) {
      const cd5h = formatResetCountdown(reset5hSec, nowMs, isZh);
      return {
        text: cd5h
          ? isZh
            ? `5h限额 ${cd5h}后重置`
            : `5h resets in ${cd5h}`
          : isZh
            ? '5h限额已重置'
            : '5h reset',
        level: fiveHLvl === 'ok' ? 'muted' : fiveHLvl
      };
    }

    if (has5h && rem5h <= 25 && (!hasWeekly || (remWeekly > 0 && rem5h <= remWeekly))) {
      const cd5h = formatResetCountdown(reset5hSec, nowMs, isZh);
      return {
        text: cd5h
          ? isZh
            ? `5h限额 ${cd5h}后重置`
            : `5h resets in ${cd5h}`
          : isZh
            ? '5h限额即将重置'
            : '5h resets soon',
        level: fiveHLvl
      };
    }

    if (hasWeekly || resetWeeklySec) {
      const cdW = formatResetCountdown(resetWeeklySec, nowMs, isZh);
      return {
        text: cdW
          ? isZh
            ? `周限额 ${cdW}后重置`
            : `Weekly resets in ${cdW}`
          : isZh
            ? '周限额已重置'
            : 'Weekly reset',
        level: weeklyLvl === 'ok' ? 'muted' : weeklyLvl
      };
    }

    if (has5h || reset5hSec) {
      const cd5h = formatResetCountdown(reset5hSec, nowMs, isZh);
      return {
        text: cd5h
          ? isZh
            ? `5h限额 ${cd5h}后重置`
            : `5h resets in ${cd5h}`
          : isZh
            ? '5h限额已重置'
            : '5h reset',
        level: fiveHLvl === 'ok' ? 'muted' : fiveHLvl
      };
    }

    return { text: isZh ? '周限额待同步' : 'Weekly pending sync', level: 'muted' };
  }

  function maskEmail(email) {
    const s = String(email || '').trim();
    const at = s.indexOf('@');
    if (at <= 0) return '';
    const local = s.slice(0, at);
    const domain = s.slice(at + 1);
    if (!domain) return '';
    return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
  }

  function normalizeAccountInfo(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const src = raw.userStatus && typeof raw.userStatus === 'object' ? raw.userStatus : raw;
    const userObj = src.user && typeof src.user === 'object' ? src.user : src;
    const email = userObj.email || src.email || src.userEmail || src.accountEmail || '';
    const maskedEmail = maskEmail(email);
    const tierObj = src.userTier && typeof src.userTier === 'object' ? src.userTier : null;
    let tierLabel = String(
      (tierObj && (tierObj.name || tierObj.id)) || src.tierLabel || src.planName || src.subscriptionTier || ''
    ).trim();
    if (/ultra/i.test(tierLabel)) tierLabel = 'Ultra';
    else if (/pro/i.test(tierLabel)) tierLabel = 'Pro';
    else if (/free|standard|individual/i.test(tierLabel)) tierLabel = 'Free';
    else if (tierLabel.length > 18) tierLabel = tierLabel.slice(0, 18);
    if (!maskedEmail && !tierLabel) return null;
    return { maskedEmail, tierLabel };
  }

  function normalizeGroupsForCache(groups) {
    if (!Array.isArray(groups)) return [];
    return groups
      .filter((g) => g && typeof g === 'object')
      .map((g) => ({
        displayName: String(g.displayName || '').trim(),
        description: String(g.description || '').trim(),
        buckets: Array.isArray(g.buckets)
          ? g.buckets
              .filter((b) => b && typeof b === 'object')
              .map((b) => ({
                bucketId: String(b.bucketId || '').trim(),
                displayName: String(b.displayName || '').trim(),
                window: String(b.window || '').trim(),
                remainingFraction: readBucketRemainingFraction(b),
                resetSec: readResetSec(b.resetTime ?? b.resetSec)
              }))
          : []
      }));
  }

  function detectTurnFinishedSignal(prevState, nextSnapshot) {
    const prevCancel = Boolean(prevState?.wasCancelBtnVisible);
    const nextCancel = Boolean(nextSnapshot?.hasCancelBtn);
    const prevSig = prevState?.lastMetricsSig ?? null;
    const nextSig = String(nextSnapshot?.metricsSig || '');

    let triggered = false;
    if (prevCancel && !nextCancel) {
      triggered = true;
    } else if (nextSig && prevSig !== null && prevSig !== '' && nextSig !== prevSig) {
      triggered = true;
    }

    return {
      triggered,
      nextState: {
        wasCancelBtnVisible: nextCancel,
        lastMetricsSig: nextSig !== '' ? nextSig : prevSig
      }
    };
  }

  function resolveCompactRingModel(globalGroup, isZh = true) {
    const weekBucket = getBucketByWindow(globalGroup, 'weekly');
    const fiveBucket = getBucketByWindow(globalGroup, '5h');
    const remWeekly = weekBucket ? calcRemainingPct(weekBucket.remainingFraction, false) : null;
    const rem5h = fiveBucket ? calcRemainingPct(fiveBucket.remainingFraction, false) : null;

    if (rem5h !== null && remWeekly !== null) {
      return {
        mode: 'dual',
        outerPct: rem5h,
        innerPct: remWeekly,
        segments: [
          { key: '5h', pct: rem5h },
          { key: '7d', pct: remWeekly }
        ]
      };
    }
    if (remWeekly !== null) {
      return {
        mode: 'single',
        outerPct: remWeekly,
        innerPct: null,
        segments: [{ key: '7d', pct: remWeekly }]
      };
    }
    if (rem5h !== null) {
      return {
        mode: 'single',
        outerPct: rem5h,
        innerPct: null,
        segments: [{ key: '5h', pct: rem5h }]
      };
    }
    const buckets = Array.isArray(globalGroup?.buckets) ? globalGroup.buckets : [];
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      const pct = calcRemainingPct(b?.remainingFraction, false);
      if (pct !== null) {
        return {
          mode: 'single',
          outerPct: pct,
          innerPct: null,
          segments: [{ key: b.displayName || (isZh ? '配额' : 'Quota'), pct }]
        };
      }
    }
    return { mode: 'empty', outerPct: null, innerPct: null, segments: [] };
  }

  function encodePrefsCookieValue(prefsObj, updatedAtSec = 0) {
    const style = normalizeQuotaBarStyleValue(prefsObj?.style);
    const click = normalizeQuotaBarClickValue(prefsObj?.click);
    const reset5h = normalizeQuotaBarReset5hValue(prefsObj?.reset5h) ? '1' : '0';
    const rawTs = Number(updatedAtSec);
    const ts = Number.isFinite(rawTs) && rawTs > 0 ? Math.floor(rawTs) : 0;
    return ts > 0 ? `${style}|${click}|${reset5h}|${ts}` : `${style}|${click}|${reset5h}`;
  }

  function parsePrefsCookieString(cookieStr, key = 'ag_qb_prefs') {
    const src = String(cookieStr || '');
    if (!src) return null;
    const partsList = src.split(';');
    let rawVal = null;
    for (let i = 0; i < partsList.length; i++) {
      const item = partsList[i].trim();
      if (!item) continue;
      const eq = item.indexOf('=');
      if (eq <= 0) continue;
      if (item.slice(0, eq).trim() === key) {
        rawVal = item.slice(eq + 1).trim();
        break;
      }
    }
    if (rawVal === null || rawVal === '') return null;
    let decoded = rawVal;
    try {
      decoded = decodeURIComponent(rawVal);
    } catch (e) {}
    const fields = decoded.split('|');
    if (fields.length !== 3 && fields.length !== 4) return null;
    if (!fields[0] || !fields[1] || (fields[2] !== '0' && fields[2] !== '1')) return null;
    let updatedAt = 0;
    if (fields.length === 4) {
      if (!/^\d+$/.test(fields[3])) return null;
      const n = Number(fields[3]);
      updatedAt = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    }
    return {
      style: normalizeQuotaBarStyleValue(fields[0]),
      click: normalizeQuotaBarClickValue(fields[1]),
      reset5h: fields[2] === '1',
      updatedAt
    };
  }

  function mergeStoredPrefs(localParsed, cookieParsed, defaults = {}) {
    const def = {
      style: normalizeQuotaBarStyleValue(defaults?.style),
      click: normalizeQuotaBarClickValue(defaults?.click),
      reset5h: normalizeQuotaBarReset5hValue(defaults?.reset5h)
    };
    const normalizeEntry = (entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const rawTs = Number(entry.updatedAt);
      return {
        style: entry.style !== undefined ? normalizeQuotaBarStyleValue(entry.style) : def.style,
        click: entry.click !== undefined ? normalizeQuotaBarClickValue(entry.click) : def.click,
        reset5h: entry.reset5h !== undefined ? normalizeQuotaBarReset5hValue(entry.reset5h) : def.reset5h,
        updatedAt: Number.isFinite(rawTs) && rawTs > 0 ? Math.floor(rawTs) : 0
      };
    };

    const localEntry = normalizeEntry(localParsed);
    const cookieEntry = normalizeEntry(cookieParsed);

    if (localEntry && cookieEntry) {
      if (cookieEntry.updatedAt > localEntry.updatedAt) {
        return {
          prefs: { style: cookieEntry.style, click: cookieEntry.click, reset5h: cookieEntry.reset5h },
          source: 'cookie',
          updatedAt: cookieEntry.updatedAt,
          needsLocalBackfill: true,
          needsCookieBackfill: false
        };
      }
      const sameVals =
        localEntry.style === cookieEntry.style &&
        localEntry.click === cookieEntry.click &&
        localEntry.reset5h === cookieEntry.reset5h;
      return {
        prefs: { style: localEntry.style, click: localEntry.click, reset5h: localEntry.reset5h },
        source: 'local',
        updatedAt: Math.max(localEntry.updatedAt, cookieEntry.updatedAt),
        needsLocalBackfill: false,
        needsCookieBackfill: !sameVals || localEntry.updatedAt > cookieEntry.updatedAt
      };
    }

    if (localEntry) {
      return {
        prefs: { style: localEntry.style, click: localEntry.click, reset5h: localEntry.reset5h },
        source: 'local',
        updatedAt: localEntry.updatedAt,
        needsLocalBackfill: false,
        needsCookieBackfill: true
      };
    }

    if (cookieEntry) {
      return {
        prefs: { style: cookieEntry.style, click: cookieEntry.click, reset5h: cookieEntry.reset5h },
        source: 'cookie',
        updatedAt: cookieEntry.updatedAt,
        needsLocalBackfill: true,
        needsCookieBackfill: false
      };
    }

    return {
      prefs: def,
      source: 'default',
      updatedAt: 0,
      needsLocalBackfill: false,
      needsCookieBackfill: false
    };
  }
  /* QUOTA_BAR_LOGIC_END */

  const SETTINGS_UI_STRINGS = {
    'zh-CN': {
      styleLabel: '配额样式',
      clickLabel: '配额点击',
      reset5hLabel: '同时展示 5h 倒计时',
      reset5hDesc: '不勾选时仅显示周限额倒计时，5h 剩余 ≤25% 时自动切换',
      styleBar: '进度条',
      styleRing: '圆环',
      styleCompact: '极简',
      styleBarTip: '双圆角进度条（窄边栏自动缩为双圆环）',
      styleRingTip: '左右并列双圆环配额指示器',
      styleCompactTip: '极简单行同心双环（与系统设置齐平，点小圆环直刷，悬停查看各池详情）',
      clickPopover: '详情卡',
      clickRefresh: '刷新',
      clickSettings: '设置',
      clickPopoverTip: '点击弹出配额详情浮层',
      clickRefreshTip: '点击静默刷新配额（悬停仍可预览详情）',
      clickSettingsTip: '点击跳转 Models & Usage（悬停仍可预览详情）'
    },
    ja: {
      styleLabel: 'クォータ表示',
      clickLabel: 'クリック動作',
      reset5hLabel: '5時間リセットも同時表示',
      reset5hDesc: 'オフ時は週間リセットのみ表示（5時間残量 ≤25% で自動切替）',
      styleBar: 'バー',
      styleRing: 'リング',
      styleCompact: 'コンパクト',
      styleBarTip: 'デュアル角丸バー（狭いサイドバーはリングに自動切替）',
      styleRingTip: '左右並びリングインジケーター',
      styleCompactTip: '1行のコンパクトなデュアルリング（リングクリックで即更新・ホバーで詳細表示）',
      clickPopover: '詳細',
      clickRefresh: '更新',
      clickSettings: '設定',
      clickPopoverTip: 'クリックでクォータ詳細カードを表示',
      clickRefreshTip: 'クリックでクォータを更新（ホバーで詳細表示）',
      clickSettingsTip: 'クリックで Models & Usage を開く（ホバーで詳細表示）'
    },
    en: {
      styleLabel: 'Quota Display',
      clickLabel: 'Quota Click',
      reset5hLabel: 'Also Show 5h Countdown',
      reset5hDesc: 'When off, shows weekly reset only; auto-switches to 5h when ≤25% left',
      styleBar: 'Bar',
      styleRing: 'Ring',
      styleCompact: 'Compact',
      styleBarTip: 'Dual rounded bars (auto dual-ring when narrow)',
      styleRingTip: 'Side-by-side dual-ring indicator',
      styleCompactTip: 'Minimal single-row dual ring (click ring to refresh, hover for all pools)',
      clickPopover: 'Details',
      clickRefresh: 'Refresh',
      clickSettings: 'Settings',
      clickPopoverTip: 'Click to toggle quota details card',
      clickRefreshTip: 'Click to refresh silently (hover for details)',
      clickSettingsTip: 'Click to open Models & Usage (hover for details)'
    }
  };

  function getCurrentLang() {
    try {
      const attr = String(document.documentElement?.getAttribute('data-ag-lang') || '').trim();
      if (attr) {
        const low = attr.toLowerCase();
        if (low === 'en') return 'en';
        if (low.startsWith('ja')) return 'ja';
        if (low.startsWith('zh')) return 'zh-CN';
      }
    } catch (e) {}
    if (ctx?.modules?.i18n === false) return 'en';
    const inst = String(ctx?.config?.installedLocale || 'zh-CN').trim().toLowerCase();
    if (inst === 'none') return 'en';
    if (inst.startsWith('ja')) return 'ja';
    return 'zh-CN';
  }

  function isZhLang() {
    return getCurrentLang() === 'zh-CN';
  }

  function getQbStrings() {
    const lang = getCurrentLang();
    return SETTINGS_UI_STRINGS[lang] || SETTINGS_UI_STRINGS.en;
  }

  function readPrefsFromLocalStorage() {
    try {
      const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function readPrefsFromCookie() {
    try {
      if (typeof document === 'undefined' || typeof document.cookie !== 'string') return null;
      return parsePrefsCookieString(document.cookie, PREFS_COOKIE_KEY);
    } catch (e) {
      return null;
    }
  }

  function writePrefsToLocalStorage(nextPrefs, updatedAt = 0) {
    try {
      window.localStorage.setItem(
        PREFS_STORAGE_KEY,
        JSON.stringify({
          style: normalizeQuotaBarStyleValue(nextPrefs.style),
          click: normalizeQuotaBarClickValue(nextPrefs.click),
          reset5h: normalizeQuotaBarReset5hValue(nextPrefs.reset5h),
          updatedAt: updatedAt > 0 ? updatedAt : Math.floor(Date.now() / 1000)
        })
      );
    } catch (e) {}
  }

  function writePrefsToCookie(nextPrefs, updatedAt = 0) {
    try {
      if (typeof document === 'undefined' || typeof document.cookie !== 'string') return;
      const val = encodePrefsCookieValue(nextPrefs, updatedAt);
      const isHttps = typeof window !== 'undefined' && window.location?.protocol === 'https:';
      const secureAttr = isHttps ? '; Secure' : '';
      document.cookie = `${PREFS_COOKIE_KEY}=${val}; Path=/; Max-Age=${PREFS_COOKIE_MAX_AGE_SEC}; SameSite=Lax${secureAttr}`;
    } catch (e) {}
  }

  function readPrefsFromStorage() {
    const cfg = ctx?.config || {};
    const defaults = {
      style: normalizeQuotaBarStyleValue(cfg.quotaBarStyle ?? window.__ag_quota_bar_style),
      click: normalizeQuotaBarClickValue(cfg.quotaBarClick ?? window.__ag_quota_bar_click),
      reset5h: normalizeQuotaBarReset5hValue(cfg.quotaBarReset5h ?? window.__ag_quota_bar_reset_5h)
    };
    const merged = mergeStoredPrefs(readPrefsFromLocalStorage(), readPrefsFromCookie(), defaults);
    const backfillTs = merged.updatedAt > 0 ? merged.updatedAt : Math.floor(Date.now() / 1000);
    if (merged.needsCookieBackfill) {
      writePrefsToCookie(merged.prefs, backfillTs);
    }
    if (merged.needsLocalBackfill) {
      writePrefsToLocalStorage(merged.prefs, backfillTs);
    }
    return merged.prefs;
  }

  function writePrefsToStorage(nextPrefs, updatedAt = Math.floor(Date.now() / 1000)) {
    const normalized = {
      style: normalizeQuotaBarStyleValue(nextPrefs.style),
      click: normalizeQuotaBarClickValue(nextPrefs.click),
      reset5h: normalizeQuotaBarReset5hValue(nextPrefs.reset5h)
    };
    writePrefsToLocalStorage(normalized, updatedAt);
    writePrefsToCookie(normalized, updatedAt);
  }

  let prefs = readPrefsFromStorage();
  window.__ag_quota_bar_style = prefs.style;
  window.__ag_quota_bar_click = prefs.click;
  window.__ag_quota_bar_reset_5h = prefs.reset5h;

  function getStylePref() {
    return normalizeQuotaBarStyleValue(prefs.style);
  }

  function getReset5hPref() {
    return normalizeQuotaBarReset5hValue(prefs.reset5h);
  }

  function getClickPref() {
    return normalizeQuotaBarClickValue(prefs.click);
  }

  function getHooks() {
    const h = window.__agQuotaBarHooks;
    return h && typeof h === 'object' ? h : {};
  }

  let disposed = false;
  let cachedServices = null;
  let fiberAuthScanDone = false;
  let cachedFiberUserStatus = null;
  let cachedAccountMeta = null;
  let cachedRawAccountStatus = null;
  let accountMetaResolved = false;
  let initialHookSynced = false;
  let authSubDisposable = null;
  let lastFetchMs = 0;
  let isFetching = false;
  let hasError = false;
  let quotaState = { updatedAtSec: 0, account: null, groups: [] };
  let activeModelLabel = '';
  let tooltipOpen = false;
  let tooltipPinned = false;
  let tooltipAnchorKind = 'sidebar';
  let sidebarCompact = false;
  let coldBootRetries = 0;
  let turnWatchState = { wasCancelBtnVisible: false, lastMetricsSig: null };
  let lastPostTurnRefreshMs = 0;

  let coldBootTimer = null;
  let initialHookTimer = null;
  let pollTimer = null;
  let stateWatcherTimer = null;
  let hoverCloseTimer = null;
  let modelSyncTimer = null;
  let postTurnTimer = null;
  let settingsPollTimer = null;
  let settingsRowTimer = null;
  let optTooltipTimer = null;
  let sidebarResizeObserver = null;
  let observedSidebarEl = null;

  function formatClockTime(resetSec) {
    if (typeof resetSec !== 'number' || !Number.isFinite(resetSec) || resetSec <= 0) return '';
    try {
      const d = new Date(resetSec * 1000);
      const now = new Date();
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
      if (sameDay) return `${hh}:${mm}`;
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${m}/${day} ${hh}:${mm}`;
    } catch (e) {
      return '';
    }
  }

  function formatUpdatedClock(updatedAtSec, nowMs, isZh) {
    if (!updatedAtSec || !Number.isFinite(updatedAtSec)) return '';
    const diffSec = Math.max(0, Math.floor(nowMs / 1000 - updatedAtSec));
    if (diffSec < 15) return isZh ? '刚刚更新' : 'Updated just now';
    if (diffSec < 60) return isZh ? `${diffSec}秒前更新` : `Updated ${diffSec}s ago`;
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return isZh ? `${mins}分钟前更新` : `Updated ${mins}m ago`;
    const hours = Math.floor(mins / 60);
    return isZh ? `${hours}小时前更新` : `Updated ${hours}h ago`;
  }

  function buildRingSvg(outerPct, innerPct, sizePx = 16, opts = null) {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const compactPalette = Boolean(opts?.compactPalette);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', compactPalette ? 'ag-qb-ring-svg ag-qb-compact-ring-svg' : 'ag-qb-ring-svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', String(sizePx));
    svg.setAttribute('height', String(sizePx));
    svg.setAttribute('aria-hidden', 'true');

    const addRing = (radius, strokeWidth, pct, slot) => {
      const track = document.createElementNS(SVG_NS, 'circle');
      track.setAttribute('class', 'ag-qb-ring-track');
      track.setAttribute('cx', '8');
      track.setAttribute('cy', '8');
      track.setAttribute('r', String(radius));
      track.setAttribute('stroke-width', String(strokeWidth));
      svg.appendChild(track);

      if (typeof pct === 'number' && Number.isFinite(pct) && pct > 0) {
        const C = 2 * Math.PI * radius;
        const offset = C * (1 - Math.max(0, Math.min(100, pct)) / 100);
        const arc = document.createElementNS(SVG_NS, 'circle');
        arc.setAttribute('class', 'ag-qb-ring-arc');
        arc.setAttribute('data-level', levelOfRemaining(pct));
        if (slot) arc.setAttribute('data-ring-slot', slot);
        arc.setAttribute('cx', '8');
        arc.setAttribute('cy', '8');
        arc.setAttribute('r', String(radius));
        arc.setAttribute('stroke-width', String(strokeWidth));
        arc.setAttribute('stroke-dasharray', C.toFixed(3));
        arc.setAttribute('stroke-dashoffset', offset.toFixed(3));
        arc.setAttribute('transform', 'rotate(-90 8 8)');
        svg.appendChild(arc);
      }
    };

    let effOuter = outerPct;
    let effInner = innerPct;
    if ((effOuter === null || effOuter === undefined) && effInner !== null && effInner !== undefined) {
      effOuter = effInner;
      effInner = null;
    }

    if (effInner === null || effInner === undefined) {
      addRing(compactPalette ? 5.9 : 5.8, compactPalette ? 1.95 : 2.2, effOuter, 'outer');
    } else if (compactPalette) {
      addRing(6.3, 1.85, effOuter, 'outer');
      addRing(3.5, 1.7, effInner, 'inner');
    } else {
      addRing(6.2, 2.0, effOuter, 'outer');
      addRing(3.5, 1.9, effInner, 'inner');
    }
    return svg;
  }

  function buildRefreshIconSvg() {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const p1 = document.createElementNS(SVG_NS, 'path');
    p1.setAttribute('d', 'M21 12a9 9 0 1 1-2.64-6.36');
    const p2 = document.createElementNS(SVG_NS, 'polyline');
    p2.setAttribute('points', '21 3 21 9 15 9');
    svg.appendChild(p1);
    svg.appendChild(p2);
    return svg;
  }

  function readCacheFromStorage() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.groups)) return null;
      return {
        updatedAtSec: Number(parsed.updatedAtSec) || 0,
        account: parsed.account && typeof parsed.account === 'object' ? parsed.account : null,
        groups: normalizeGroupsForCache(parsed.groups)
      };
    } catch (e) {
      return null;
    }
  }

  function writeCacheToStorage(state) {
    try {
      const safePayload = {
        v: 1,
        updatedAtSec: Number(state.updatedAtSec) || Math.floor(Date.now() / 1000),
        account: state.account || null,
        groups: normalizeGroupsForCache(state.groups)
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(safePayload));
    } catch (e) {}
  }

  function readActiveModelName() {
    try {
      const trigger = document.querySelector('[data-testid="model-selector-trigger"]');
      if (!trigger) return '';
      return String(trigger.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) {
      return '';
    }
  }

  function findFrontendServices() {
    if (cachedServices?.cloudCodeService && (cachedServices.authService || fiberAuthScanDone)) {
      return cachedServices;
    }
    const rootEl =
      document.getElementById('root') ||
      document.getElementById('react-app') ||
      document.body?.firstElementChild ||
      null;
    if (!rootEl) return cachedServices;

    let rootFiber = null;
    try {
      const keys = Object.keys(rootEl);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$')) {
          const cand = rootEl[k];
          if (cand && typeof cand === 'object') {
            rootFiber = cand.current || cand;
            break;
          }
        }
      }
    } catch (e) {
      return cachedServices;
    }
    if (!rootFiber) return cachedServices;

    let cloudCodeService = cachedServices?.cloudCodeService || null;
    let authService = cachedServices?.authService || null;
    const visited = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    const queue = [rootFiber];
    let head = 0;
    let steps = 0;
    const MAX_NODES = 6000;
    const START_MS = performance?.now ? performance.now() : Date.now();

    const inspectBag = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 2) return;
      if (!cloudCodeService && typeof obj.retrieveUserQuotaSummary === 'function') {
        cloudCodeService = obj;
      }
      if (
        !authService &&
        (typeof obj._lsClient === 'object' ||
          typeof obj.getUserStatus === 'function' ||
          typeof obj.getAuthState === 'function' ||
          typeof obj.getUserInfo === 'function')
      ) {
        if (obj._lsClient || obj.getUserStatus || obj.getAuthState || obj.getUserInfo) {
          authService = obj;
        }
      }
      if (obj.core && typeof obj.core === 'object') {
        if (!cloudCodeService && typeof obj.core.retrieveUserQuotaSummary === 'function') {
          cloudCodeService = obj.core;
        } else if (
          !cloudCodeService &&
          obj.core.cloudCodeService &&
          typeof obj.core.cloudCodeService.retrieveUserQuotaSummary === 'function'
        ) {
          cloudCodeService = obj.core.cloudCodeService;
        }
        if (!authService && obj.core.authService && typeof obj.core.authService === 'object') {
          authService = obj.core.authService;
        }
      }
      if (obj.cloudCodeService && typeof obj.cloudCodeService.retrieveUserQuotaSummary === 'function') {
        cloudCodeService = obj.cloudCodeService;
      }
      if (obj.authService && typeof obj.authService === 'object') {
        authService = obj.authService;
      }
      if (
        !cachedFiberUserStatus &&
        obj.userStatus &&
        typeof obj.userStatus === 'object' &&
        (obj.userStatus.email || obj.userStatus.userTier || obj.userStatus.planStatus)
      ) {
        cachedFiberUserStatus = obj.userStatus;
      }
      if (depth < 2 && obj.value && typeof obj.value === 'object') {
        inspectBag(obj.value, depth + 1);
      }
      if (depth < 2 && obj.services && typeof obj.services === 'object') {
        inspectBag(obj.services, depth + 1);
      }
    };

    while (head < queue.length && steps < MAX_NODES) {
      if ((steps & 127) === 127) {
        const elapsed = (performance?.now ? performance.now() : Date.now()) - START_MS;
        if (elapsed > 60) break;
      }
      const node = queue[head++];
      if (!node || typeof node !== 'object') continue;
      if (visited) {
        if (visited.has(node)) continue;
        visited.add(node);
      }
      steps++;

      try {
        inspectBag(node.memoizedProps, 0);
        inspectBag(node.pendingProps, 0);
        if (!cloudCodeService && !authService) {
          inspectBag(node.stateNode, 0);
        }
      } catch (e) {}

      if (cloudCodeService && authService && cachedFiberUserStatus) break;
      if (node.child) queue.push(node.child);
      if (node.sibling) queue.push(node.sibling);
      if (node.alternate && (!visited || !visited.has(node.alternate))) queue.push(node.alternate);
    }

    if (!cloudCodeService) return cachedServices;
    fiberAuthScanDone = true;
    cachedServices = { cloudCodeService, authService };
    return cachedServices;
  }

  function ensureAuthChangeListener(authService) {
    if (authSubDisposable || !authService) return;
    try {
      const eventFn = authService._onAuthStateChange?.event || authService.onDidChangeLoginSession;
      if (typeof eventFn === 'function') {
        authSubDisposable = eventFn(() => {
          if (!disposed) {
            cachedFiberUserStatus = null;
            cachedAccountMeta = null;
            cachedRawAccountStatus = null;
            accountMetaResolved = false;
            cachedServices = null;
            fiberAuthScanDone = false;
            void fetchQuota(true);
          }
        });
      }
    } catch (e) {}
  }

  async function resolveAccountMetadata(authService, force = false) {
    if (!force && accountMetaResolved && cachedAccountMeta) {
      return cachedAccountMeta;
    }

    const acceptRaw = (raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const src = raw.userStatus && typeof raw.userStatus === 'object' ? raw.userStatus : raw;
      const norm = normalizeAccountInfo(src);
      if (!norm) return null;
      cachedRawAccountStatus = src;
      cachedAccountMeta = norm;
      accountMetaResolved = true;
      return norm;
    };

    const lsClient = authService?._lsClient;
    if (lsClient && typeof lsClient.getUserStatus === 'function') {
      try {
        const res = await lsClient.getUserStatus({});
        const norm = acceptRaw(res?.userStatus || res);
        if (norm) return norm;
      } catch (e) {}
    }
    try {
      if (typeof authService?.getUserStatus === 'function') {
        const res = await authService.getUserStatus();
        const norm = acceptRaw(res);
        if (norm) return norm;
      }
    } catch (e) {}
    try {
      if (typeof authService?.getAuthState === 'function') {
        const res = await authService.getAuthState();
        const norm = acceptRaw(res);
        if (norm) return norm;
      }
    } catch (e) {}
    try {
      if (typeof authService?.getUserInfo === 'function') {
        const res = await authService.getUserInfo();
        const norm = acceptRaw(res);
        if (norm) return norm;
      }
    } catch (e) {}

    return (
      acceptRaw(cachedFiberUserStatus) ||
      acceptRaw(authService) ||
      cachedAccountMeta ||
      quotaState.account
    );
  }

  function notifyQuotaUpdatedHook(rawGroups = null) {
    const hooks = getHooks();
    if (typeof hooks.onQuotaUpdated !== 'function') return;
    try {
      hooks.onQuotaUpdated({
        account: quotaState.account,
        rawAccountStatus: cachedRawAccountStatus,
        groups: quotaState.groups,
        rawGroups,
        nowSec: Math.floor(Date.now() / 1000)
      });
    } catch (e) {}
  }

  function adoptFreshStorageCacheIfNewer() {
    const fresh = readCacheFromStorage();
    if (!fresh) return false;
    const freshMs = fresh.updatedAtSec ? fresh.updatedAtSec * 1000 : 0;
    if (fresh.updatedAtSec > quotaState.updatedAtSec) {
      quotaState = fresh;
      hasError = false;
      if (freshMs > lastFetchMs) {
        lastFetchMs = freshMs;
      }
      renderAll();
      return true;
    }
    if (freshMs > lastFetchMs) {
      lastFetchMs = freshMs;
    }
    return false;
  }

  async function fetchQuota(force = false) {
    if (disposed || isFetching) return;
    if (!force) {
      adoptFreshStorageCacheIfNewer();
      if (quotaState.groups.length > 0 && lastFetchMs > 0 && Date.now() - lastFetchMs < POLL_INTERVAL_MS - 5000) {
        const hasExpired = quotaState.groups.some((g) =>
          (g.buckets || []).some(
            (b) => typeof b.resetSec === 'number' && b.resetSec > 0 && b.resetSec <= Math.floor(Date.now() / 1000)
          )
        );
        if (!hasExpired) return;
      }
    } else {
      cachedFiberUserStatus = null;
      cachedAccountMeta = null;
      cachedRawAccountStatus = null;
      accountMetaResolved = false;
    }

    const services = findFrontendServices();
    if (!services?.cloudCodeService) {
      scheduleColdBootRetry();
      return;
    }
    ensureAuthChangeListener(services.authService);
    isFetching = true;
    renderAll();
    try {
      const summary = await services.cloudCodeService.retrieveUserQuotaSummary(Boolean(force));
      const account = await resolveAccountMetadata(services.authService, Boolean(force));
      const rawGroups = Array.isArray(summary?.response?.groups)
        ? summary.response.groups
        : Array.isArray(summary?.groups)
          ? summary.groups
          : [];
      const normalizedGroups = normalizeGroupsForCache(rawGroups);
      if (normalizedGroups.length > 0) {
        quotaState = {
          updatedAtSec: Math.floor(Date.now() / 1000),
          account: account || quotaState.account || null,
          groups: normalizedGroups
        };
        hasError = false;
        lastFetchMs = Date.now();
        writeCacheToStorage(quotaState);
        initialHookSynced = true;
        notifyQuotaUpdatedHook(rawGroups);
      } else {
        hasError = quotaState.groups.length === 0;
      }
    } catch (e) {
      hasError = quotaState.groups.length === 0;
      cachedServices = null;
      fiberAuthScanDone = false;
    } finally {
      isFetching = false;
      renderAll();
    }
  }

  function scheduleColdBootRetry() {
    if (disposed || coldBootTimer || quotaState.groups.length > 0 || coldBootRetries >= MAX_COLD_BOOT_RETRIES) return;
    coldBootRetries += 1;
    coldBootTimer = setTimeout(() => {
      coldBootTimer = null;
      void fetchQuota(false);
    }, COLD_BOOT_RETRY_MS);
  }

  function openModelsSettingsTab() {
    if (settingsPollTimer) {
      clearTimeout(settingsPollTimer);
      settingsPollTimer = null;
    }
    const findVisibleModal = () => {
      const containers = document.querySelectorAll('.settings-modal-container');
      for (let i = 0; i < containers.length; i++) {
        const c = containers[i];
        const backdrop = c.closest('.settings-modal-backdrop');
        if (backdrop && backdrop.getAttribute('aria-hidden') === 'true') continue;
        if (backdrop && backdrop.classList.contains('animate-modalFadeOut')) continue;
        if (c.classList.contains('animate-modalScaleOut')) continue;
        const r = c.getBoundingClientRect();
        if (r.width > 200 && r.height > 200) return c;
      }
      return null;
    };
    const findModelsNavItem = (modal) => {
      if (!modal) return null;
      const exact =
        modal.querySelector('[data-testid="settings-nav-item-Models"]') ||
        modal.querySelector('[data-testid="settings-nav-item-models"]');
      if (exact) return exact;
      const items = modal.querySelectorAll('[data-testid^="settings-nav-item-"]');
      for (let i = 0; i < items.length; i++) {
        const el = items[i];
        const text = `${el.getAttribute('data-testid') || ''} ${el.textContent || ''}`;
        if (/models|usage|模型|用量/i.test(text)) return el;
      }
      return null;
    };
    const activateItem = (item) => {
      if (!item) return;
      const clickTarget = item.querySelector('button') || item;
      clickTarget.click();
    };
    const existingModal = findVisibleModal();
    const existingNav = findModelsNavItem(existingModal);
    if (existingNav) {
      activateItem(existingNav);
      return;
    }
    const settingsBtn = document.querySelector('[data-testid="settings-button"]');
    if (!settingsBtn) return;
    settingsBtn.click();
    let tries = 0;
    const step = () => {
      if (disposed) return;
      const modal = findVisibleModal();
      const target = findModelsNavItem(modal);
      if (target) {
        settingsPollTimer = setTimeout(() => {
          settingsPollTimer = null;
          if (!disposed) {
            const liveModal = findVisibleModal() || modal;
            activateItem(findModelsNavItem(liveModal) || target);
          }
        }, 60);
        return;
      }
      if (++tries < 30) {
        settingsPollTimer = setTimeout(step, 80);
      } else {
        settingsPollTimer = null;
      }
    };
    settingsPollTimer = setTimeout(step, 80);
  }

  function hideOptTooltip() {
    if (optTooltipTimer) {
      clearTimeout(optTooltipTimer);
      optTooltipTimer = null;
    }
    const tt = document.getElementById('ag-theme-btn-tooltip');
    if (tt) tt.removeAttribute('data-visible');
  }

  function scheduleOptTooltip(anchorBtn, getText) {
    hideOptTooltip();
    optTooltipTimer = setTimeout(() => {
      optTooltipTimer = null;
      if (disposed || !anchorBtn || !anchorBtn.isConnected || !document.body) return;
      let tt = document.getElementById('ag-theme-btn-tooltip');
      if (!tt) {
        tt = document.createElement('div');
        tt.id = 'ag-theme-btn-tooltip';
        tt.setAttribute('role', 'tooltip');
        document.body.appendChild(tt);
      }
      tt.textContent = typeof getText === 'function' ? getText() : String(getText || '');
      const r = anchorBtn.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      tt.style.left = `${Math.round(r.left + r.width / 2)}px`;
      tt.style.top = `${Math.round(r.top - 7)}px`;
      tt.setAttribute('data-visible', '1');
    }, 260);
  }

  function findAppearanceThemeGroup() {
    const marked = document.querySelector('[data-slot="toggle-group"][data-ag-theme-toggle-group="1"]');
    if (marked) return marked;
    const groups = document.querySelectorAll('.agy-card [data-slot="toggle-group"]');
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.querySelector('button[data-ag-native-theme-slot="light"]')) return g;
      if (g.getAttribute('data-ag-theme-toggle-group') === '0') continue;
      const btns = g.querySelectorAll('button');
      if (btns.length >= 3) {
        const joined = Array.from(btns)
          .map((b) => String(b.getAttribute('aria-label') || ''))
          .join('|');
        if (/light|dark|system|浅色|深色|跟随系统|ライト|ダーク/i.test(joined)) return g;
      }
    }
    return null;
  }

  function syncAppearanceQuotaSettingsRows() {
    const qbStrings = getQbStrings();
    const curStyle = getStylePref();
    const curClick = getClickPref();
    const curReset5h = getReset5hPref();

    const styleRows = document.querySelectorAll('[data-ag-quota-style-row="1"]');
    for (let i = 0; i < styleRows.length; i++) {
      const row = styleRows[i];
      const lbl = row.querySelector('[data-ag-quota-style-row-label="1"]');
      if (lbl && lbl.textContent !== qbStrings.styleLabel) lbl.textContent = qbStrings.styleLabel;
      const grp = row.querySelector('[data-ag-quota-style-group="1"]');
      if (grp) {
        if (grp.getAttribute('data-ag-active-val') !== curStyle) grp.setAttribute('data-ag-active-val', curStyle);
        const btns = grp.querySelectorAll('button[data-ag-qb-opt-btn]');
        for (let j = 0; j < btns.length; j++) {
          const b = btns[j];
          const v = b.getAttribute('data-ag-qb-opt-btn');
          const on = v === curStyle;
          if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on));
          const wantText =
            v === 'compact' ? qbStrings.styleCompact : v === 'ring' ? qbStrings.styleRing : qbStrings.styleBar;
          const wantTip =
            v === 'compact' ? qbStrings.styleCompactTip : v === 'ring' ? qbStrings.styleRingTip : qbStrings.styleBarTip;
          if (b.textContent !== wantText) b.textContent = wantText;
          if (b.getAttribute('aria-label') !== wantTip) b.setAttribute('aria-label', wantTip);
        }
      }
    }

    const clickRows = document.querySelectorAll('[data-ag-quota-click-row="1"]');
    for (let i = 0; i < clickRows.length; i++) {
      const row = clickRows[i];
      const lbl = row.querySelector('[data-ag-quota-click-row-label="1"]');
      if (lbl && lbl.textContent !== qbStrings.clickLabel) lbl.textContent = qbStrings.clickLabel;
      const grp = row.querySelector('[data-ag-quota-click-group="1"]');
      if (grp) {
        if (grp.getAttribute('data-ag-active-val') !== curClick) grp.setAttribute('data-ag-active-val', curClick);
        const btns = grp.querySelectorAll('button[data-ag-qb-opt-btn]');
        for (let j = 0; j < btns.length; j++) {
          const b = btns[j];
          const v = b.getAttribute('data-ag-qb-opt-btn');
          const on = v === curClick;
          if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on));
          const wantText =
            v === 'refresh'
              ? qbStrings.clickRefresh
              : v === 'settings'
                ? qbStrings.clickSettings
                : qbStrings.clickPopover;
          const wantTip =
            v === 'refresh'
              ? qbStrings.clickRefreshTip
              : v === 'settings'
                ? qbStrings.clickSettingsTip
                : qbStrings.clickPopoverTip;
          if (b.textContent !== wantText) b.textContent = wantText;
          if (b.getAttribute('aria-label') !== wantTip) b.setAttribute('aria-label', wantTip);
        }
      }
    }

    const reset5hRows = document.querySelectorAll('[data-ag-quota-reset5h-row="1"]');
    for (let i = 0; i < reset5hRows.length; i++) {
      const row = reset5hRows[i];
      const lbl = row.querySelector('[data-ag-quota-reset5h-row-label="1"]');
      if (lbl && lbl.textContent !== qbStrings.reset5hLabel) lbl.textContent = qbStrings.reset5hLabel;
      const desc = row.querySelector('[data-ag-quota-reset5h-row-desc="1"]');
      if (desc && desc.textContent !== qbStrings.reset5hDesc) desc.textContent = qbStrings.reset5hDesc;
      const sw = row.querySelector('[data-ag-qb-reset5h-switch="1"]');
      if (sw) {
        if (sw.getAttribute('aria-checked') !== String(curReset5h)) sw.setAttribute('aria-checked', String(curReset5h));
        if (sw.getAttribute('aria-label') !== qbStrings.reset5hLabel) sw.setAttribute('aria-label', qbStrings.reset5hLabel);
      }
    }
  }

  function ensureAppearanceQuotaSettingsRows() {
    const group = findAppearanceThemeGroup();
    if (!group) return false;
    const qbThemeRow = group.closest ? group.closest('.agy-card > div') : null;
    const qbCard = qbThemeRow ? qbThemeRow.parentElement : null;
    if (!qbCard) return false;

    const sampleBtn = group.querySelector('button[data-ag-native-theme-slot="light"]') || group.querySelector('button');
    const btnClassName = sampleBtn ? sampleBtn.className : '';
    const rowClassName =
      qbThemeRow?.className || 'py-2 px-3 w-full bg-transparent flex justify-between gap-4 items-center';
    const qbStrings = getQbStrings();

    const mkSegRow = (rowAttr, labelAttr, groupAttr, initVal, initLabel, options, onSelect) => {
      const row = document.createElement('div');
      row.setAttribute(rowAttr, '1');
      row.setAttribute('data-ag-quota-ui', '1');
      row.className = rowClassName;

      const leftCol = document.createElement('div');
      leftCol.className = 'flex-1 flex flex-col gap-0.5';
      const labelInner = document.createElement('div');
      labelInner.className = 'flex items-center gap-1.5';
      const labelSpan = document.createElement('span');
      labelSpan.setAttribute(labelAttr, '1');
      labelSpan.textContent = initLabel;
      labelInner.appendChild(labelSpan);
      leftCol.appendChild(labelInner);

      const rightCol = document.createElement('div');
      rightCol.className = 'shrink-0';
      const segGroup = document.createElement('div');
      segGroup.setAttribute('data-orientation', 'horizontal');
      segGroup.setAttribute('aria-orientation', 'horizontal');
      segGroup.setAttribute('role', 'group');
      segGroup.setAttribute('data-slot', 'toggle-group');
      segGroup.setAttribute('data-ag-theme-toggle-group', '0');
      segGroup.setAttribute(groupAttr, '1');
      segGroup.setAttribute('data-ag-active-val', initVal);
      segGroup.className = group.className;

      for (let k = 0; k < options.length; k++) {
        const opt = options[k];
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('data-ag-qb-opt-btn', opt.val);
        b.setAttribute('aria-label', opt.getTip());
        b.setAttribute('aria-pressed', String(initVal === opt.val));
        b.className = btnClassName;
        b.textContent = opt.getLabel();
        b.addEventListener('mouseenter', () => {
          scheduleOptTooltip(b, opt.getTip);
        });
        b.addEventListener('mouseleave', hideOptTooltip);
        b.addEventListener('focus', () => {
          scheduleOptTooltip(b, opt.getTip);
        });
        b.addEventListener('blur', hideOptTooltip);
        b.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          onSelect(opt.val);
        });
        segGroup.appendChild(b);
      }

      rightCol.appendChild(segGroup);
      row.appendChild(leftCol);
      row.appendChild(rightCol);
      return row;
    };

    if (!qbCard.querySelector('[data-ag-quota-style-row="1"]')) {
      const curStyle = getStylePref();
      const styleRow = mkSegRow(
        'data-ag-quota-style-row',
        'data-ag-quota-style-row-label',
        'data-ag-quota-style-group',
        curStyle,
        qbStrings.styleLabel,
        [
          {
            val: 'bar',
            getLabel: () => getQbStrings().styleBar,
            getTip: () => getQbStrings().styleBarTip
          },
          {
            val: 'ring',
            getLabel: () => getQbStrings().styleRing,
            getTip: () => getQbStrings().styleRingTip
          },
          {
            val: 'compact',
            getLabel: () => getQbStrings().styleCompact,
            getTip: () => getQbStrings().styleCompactTip
          }
        ],
        (val) => {
          setQuotaBarPrefs({ style: val }, true);
        }
      );
      qbCard.appendChild(styleRow);
    }

    if (!qbCard.querySelector('[data-ag-quota-click-row="1"]')) {
      const curClick = getClickPref();
      const clickRow = mkSegRow(
        'data-ag-quota-click-row',
        'data-ag-quota-click-row-label',
        'data-ag-quota-click-group',
        curClick,
        qbStrings.clickLabel,
        [
          {
            val: 'popover',
            getLabel: () => getQbStrings().clickPopover,
            getTip: () => getQbStrings().clickPopoverTip
          },
          {
            val: 'refresh',
            getLabel: () => getQbStrings().clickRefresh,
            getTip: () => getQbStrings().clickRefreshTip
          },
          {
            val: 'settings',
            getLabel: () => getQbStrings().clickSettings,
            getTip: () => getQbStrings().clickSettingsTip
          }
        ],
        (val) => {
          setQuotaBarPrefs({ click: val }, true);
        }
      );
      qbCard.appendChild(clickRow);
    }

    if (!qbCard.querySelector('[data-ag-quota-reset5h-row="1"]')) {
      const curReset5h = getReset5hPref();
      const reset5hRow = document.createElement('div');
      reset5hRow.setAttribute('data-ag-quota-reset5h-row', '1');
      reset5hRow.setAttribute('data-ag-quota-ui', '1');
      reset5hRow.className = rowClassName;

      const leftCol = document.createElement('div');
      leftCol.className = 'flex-1 flex flex-col gap-0.5';
      const labelInner = document.createElement('div');
      labelInner.className = 'flex items-center gap-1.5';
      const labelSpan = document.createElement('span');
      labelSpan.setAttribute('data-ag-quota-reset5h-row-label', '1');
      labelSpan.textContent = qbStrings.reset5hLabel;
      labelInner.appendChild(labelSpan);
      const descSpan = document.createElement('span');
      descSpan.className = 'ag-qb-row-desc';
      descSpan.setAttribute('data-ag-quota-reset5h-row-desc', '1');
      descSpan.textContent = qbStrings.reset5hDesc;
      leftCol.appendChild(labelInner);
      leftCol.appendChild(descSpan);

      const rightCol = document.createElement('div');
      rightCol.className = 'shrink-0 flex items-center';
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('data-ag-qb-reset5h-switch', '1');
      sw.setAttribute('aria-checked', String(curReset5h));
      sw.setAttribute('aria-label', qbStrings.reset5hLabel);
      const thumb = document.createElement('span');
      thumb.className = 'ag-qb-switch-thumb';
      sw.appendChild(thumb);
      sw.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const nextVal = !getReset5hPref();
        setQuotaBarPrefs({ reset5h: nextVal }, true);
      });
      rightCol.appendChild(sw);

      reset5hRow.appendChild(leftCol);
      reset5hRow.appendChild(rightCol);
      qbCard.appendChild(reset5hRow);
    }

    syncAppearanceQuotaSettingsRows();
    return true;
  }

  function setQuotaBarPrefs(nextPrefs, persist = true) {
    if (!nextPrefs || typeof nextPrefs !== 'object') return;
    const next = {
      style: nextPrefs.style !== undefined ? normalizeQuotaBarStyleValue(nextPrefs.style) : prefs.style,
      click: nextPrefs.click !== undefined ? normalizeQuotaBarClickValue(nextPrefs.click) : prefs.click,
      reset5h: nextPrefs.reset5h !== undefined ? normalizeQuotaBarReset5hValue(nextPrefs.reset5h) : prefs.reset5h
    };
    prefs = next;
    window.__ag_quota_bar_style = next.style;
    window.__ag_quota_bar_click = next.click;
    window.__ag_quota_bar_reset_5h = next.reset5h;
    if (persist) {
      writePrefsToStorage(next);
    }
    syncAppearanceQuotaSettingsRows();
    renderAll();
  }

  function cancelHoverClose() {
    if (hoverCloseTimer) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = null;
    }
  }

  function scheduleHoverClose() {
    cancelHoverClose();
    hoverCloseTimer = setTimeout(() => {
      hoverCloseTimer = null;
      if (!tooltipPinned) {
        closeTooltip();
      }
    }, 180);
  }

  function closeTooltip() {
    cancelHoverClose();
    if (!tooltipOpen) return;
    tooltipOpen = false;
    tooltipPinned = false;
    try {
      getHooks().onTooltipClose?.();
    } catch (e) {}
    const tt = document.getElementById(TOOLTIP_ID);
    if (tt) {
      tt.removeAttribute('data-open');
      tt.removeAttribute('data-visible');
    }
    const sb = document.getElementById(SIDEBAR_BTN_ID);
    if (sb) sb.setAttribute('aria-expanded', 'false');
    const pill = document.getElementById(PILL_ID);
    if (pill) pill.setAttribute('aria-expanded', 'false');
  }

  function positionTooltip(anchorEl, anchorKind) {
    const tt = document.getElementById(TOOLTIP_ID);
    if (!tt || !anchorEl) return;
    const ar = anchorEl.getBoundingClientRect();
    if (ar.width <= 0 || ar.height <= 0) return;

    tt.style.visibility = 'hidden';
    tt.setAttribute('data-open', '1');
    tt.setAttribute('data-visible', '1');
    const tr = tt.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;

    let left = ar.left;
    let top = ar.bottom + 8;

    if (anchorKind === 'sidebar') {
      if (sidebarCompact) {
        left = ar.right + 10;
        top = ar.bottom - tr.height;
      } else {
        left = ar.left;
        top = ar.top - tr.height - 8;
        if (top < 10) {
          top = ar.bottom + 8;
        }
      }
    } else {
      left = Math.min(ar.left, vw - tr.width - 12);
      top = ar.bottom + 8;
    }

    left = Math.max(10, Math.min(left, vw - tr.width - 10));
    top = Math.max(10, Math.min(top, vh - tr.height - 10));
    tt.style.left = `${Math.round(left)}px`;
    tt.style.top = `${Math.round(top)}px`;
    tt.style.visibility = '';
  }

  function openTooltip(anchorEl, anchorKind, pinned = true) {
    if (!anchorEl) return;
    cancelHoverClose();
    tooltipAnchorKind = anchorKind;
    tooltipOpen = true;
    tooltipPinned = Boolean(pinned);
    renderTooltip();
    positionTooltip(anchorEl, anchorKind);
    const sb = document.getElementById(SIDEBAR_BTN_ID);
    if (sb) sb.setAttribute('aria-expanded', String(tooltipPinned && anchorKind === 'sidebar'));
    const pill = document.getElementById(PILL_ID);
    if (pill) pill.setAttribute('aria-expanded', String(tooltipPinned && anchorKind === 'titlebar'));
    if (quotaState.groups.length === 0 && !isFetching) {
      void fetchQuota(true);
    }
  }

  function handleTriggerClick(anchorEl, anchorKind, ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    const clickMode = getClickPref();
    if (clickMode === 'refresh') {
      if (tooltipOpen && tooltipPinned) closeTooltip();
      void fetchQuota(true);
      return;
    }
    if (clickMode === 'settings') {
      closeTooltip();
      openModelsSettingsTab();
      return;
    }
    if (tooltipOpen && tooltipPinned && tooltipAnchorKind === anchorKind) {
      closeTooltip();
    } else {
      openTooltip(anchorEl, anchorKind, true);
    }
  }

  function bindTriggerInteraction(el, anchorKind) {
    if (el.__ag_qb_bound) return;
    el.__ag_qb_bound = true;
    el.addEventListener('click', (ev) => {
      if (ev?.target instanceof Element && ev.target.closest('.ag-qb-compact-ring-btn')) return;
      handleTriggerClick(el, anchorKind, ev);
    });
    el.addEventListener('keydown', (ev) => {
      if (ev?.target instanceof Element && ev.target.closest('.ag-qb-compact-ring-btn')) return;
      if (ev.key === 'Enter' || ev.key === ' ') {
        handleTriggerClick(el, anchorKind, ev);
      }
    });
    el.addEventListener('mouseenter', () => {
      if (tooltipOpen && tooltipPinned && tooltipAnchorKind === anchorKind) {
        cancelHoverClose();
        return;
      }
      const clickMode = getClickPref();
      if (clickMode === 'refresh' || clickMode === 'settings' || (anchorKind === 'sidebar' && getStylePref() === 'compact')) {
        openTooltip(el, anchorKind, false);
      }
    });
    el.addEventListener('mouseleave', () => {
      if (!tooltipPinned) {
        scheduleHoverClose();
      }
    });
  }

  function ensureSidebarWrap() {
    const settingsBtn = document.querySelector('[data-testid="settings-button"]');
    if (!settingsBtn || !settingsBtn.parentElement) {
      document.getElementById(SIDEBAR_WRAP_ID)?.remove();
      return null;
    }
    const parent = settingsBtn.parentElement;
    if (parent !== observedSidebarEl) {
      if (sidebarResizeObserver) {
        try {
          sidebarResizeObserver.disconnect();
        } catch (e) {}
      }
      observedSidebarEl = parent;
      const w = parent.getBoundingClientRect().width;
      sidebarCompact = w > 0 && w < COMPACT_WIDTH_PX;
      if (typeof ResizeObserver !== 'undefined') {
        sidebarResizeObserver = new ResizeObserver((entries) => {
          const width = entries?.[0]?.contentRect?.width;
          if (typeof width === 'number' && width > 0) {
            const nextCompact = width < COMPACT_WIDTH_PX;
            if (nextCompact !== sidebarCompact) {
              sidebarCompact = nextCompact;
              renderSidebarWidget();
            }
          }
        });
        sidebarResizeObserver.observe(parent);
      }
    }

    let wrap = document.getElementById(SIDEBAR_WRAP_ID);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = SIDEBAR_WRAP_ID;
      wrap.setAttribute('data-ag-quota-ui', '1');
    }
    if (wrap.parentElement !== parent || wrap.nextElementSibling !== settingsBtn) {
      parent.insertBefore(wrap, settingsBtn);
    }
    if (sidebarCompact) {
      wrap.setAttribute('data-compact', '1');
    } else {
      wrap.removeAttribute('data-compact');
    }

    let btn = wrap.firstElementChild;
    if (!btn || btn.id !== SIDEBAR_BTN_ID) {
      wrap.replaceChildren();
      btn = document.createElement('div');
      btn.id = SIDEBAR_BTN_ID;
      btn.setAttribute('role', 'button');
      btn.setAttribute('tabindex', '0');
      btn.setAttribute('data-ag-quota-ui', '1');
      btn.setAttribute('aria-expanded', 'false');
      wrap.appendChild(btn);
    }
    bindTriggerInteraction(btn, 'sidebar');
    return { wrap, btn };
  }

  function resetSidebarBtnInlineStyle(btn) {
    if (!btn?.style) return;
    btn.style.height = '';
    btn.style.paddingLeft = '';
    btn.style.paddingRight = '';
    btn.style.gap = '';
    btn.style.borderRadius = '';
    btn.style.fontSize = '';
    btn.style.fontWeight = '';
    btn.style.color = '';
  }

  function syncCompactRowGeometry(btn) {
    let iconSize = 16;
    const settingsBtn = document.querySelector('[data-testid="settings-button"]');
    if (!settingsBtn || typeof window.getComputedStyle !== 'function') return iconSize;
    try {
      const cs = window.getComputedStyle(settingsBtn);
      const sRect = settingsBtn.getBoundingClientRect();
      const iconEl = settingsBtn.querySelector('svg');
      const iconRect = iconEl ? iconEl.getBoundingClientRect() : null;
      const textEl =
        Array.from(settingsBtn.querySelectorAll('span')).find((el) => (el.textContent || '').trim().length > 0) ||
        settingsBtn;
      const tcs = window.getComputedStyle(textEl);

      if (sRect && sRect.height >= 22 && sRect.height <= 44) {
        btn.style.height = `${Math.round(sRect.height)}px`;
      }
      if (cs.paddingLeft) btn.style.paddingLeft = cs.paddingLeft;
      if (cs.paddingRight) btn.style.paddingRight = cs.paddingRight;
      if (cs.borderRadius) btn.style.borderRadius = cs.borderRadius;
      if (tcs.fontSize) {
        const basePx = parseFloat(tcs.fontSize);
        btn.style.fontSize = Number.isFinite(basePx)
          ? `${Math.max(12, Math.min(14, Math.round(basePx - 1)))}px`
          : tcs.fontSize;
      }
      if (tcs.fontWeight) btn.style.fontWeight = tcs.fontWeight;
      btn.style.color = '';

      if (iconRect && iconRect.width >= 12 && iconRect.width <= 22) {
        iconSize = Math.max(15, Math.min(18, Math.round(iconRect.width)));
      }
      const textRect = textEl && textEl !== settingsBtn ? textEl.getBoundingClientRect() : null;
      if (iconRect && textRect && textRect.left > iconRect.right) {
        btn.style.gap = `${Math.max(4, Math.min(16, Math.round(textRect.left - iconRect.right)))}px`;
      } else if (cs.columnGap || cs.gap) {
        btn.style.gap = cs.columnGap || cs.gap;
      }
    } catch (e) {}
    return iconSize;
  }

  function renderSidebarWidget() {
    const refs = ensureSidebarWrap();
    if (!refs) return;
    const { wrap, btn } = refs;
    const isZh = isZhLang();
    const stylePref = getStylePref();
    const clickPref = getClickPref();
    wrap.setAttribute('data-style-mode', stylePref);
    btn.setAttribute('data-style', stylePref);
    if (isFetching) btn.setAttribute('data-loading', '1');
    else btn.removeAttribute('data-loading');

    const nowMs = Date.now();
    const globalGroup = findGlobalGroup(quotaState.groups);
    const weekBucket = getBucketByWindow(globalGroup, 'weekly');
    const fiveBucket = getBucketByWindow(globalGroup, '5h');
    const remWeekly = weekBucket ? calcRemainingPct(weekBucket.remainingFraction, false) : null;
    const rem5h = fiveBucket ? calcRemainingPct(fiveBucket.remainingFraction, false) : null;
    const reset5hSec = fiveBucket?.resetSec ?? null;

    const actionHint =
      clickPref === 'refresh'
        ? isZh
          ? '点击刷新'
          : 'Click to refresh'
        : clickPref === 'settings'
          ? isZh
            ? '点击打开设置'
            : 'Click for Settings'
          : isZh
            ? '点击查看详情'
            : 'Click for details';
    const ariaSummary = `${isZh ? '全局配额' : 'Global Quota'} · 5h ${rem5h ?? '--'}% · ${isZh ? '周' : 'Weekly'} ${remWeekly ?? '--'}% (${actionHint})`;
    btn.setAttribute('aria-label', ariaSummary);
    if (sidebarCompact) {
      btn.setAttribute('title', ariaSummary);
    } else {
      btn.removeAttribute('title');
    }

    const compactModel = resolveCompactRingModel(globalGroup, isZh);

    btn.replaceChildren();
    if (sidebarCompact) {
      resetSidebarBtnInlineStyle(btn);
      wrap.setAttribute('data-compact', '1');
      btn.appendChild(
        buildRingSvg(compactModel.outerPct, compactModel.innerPct, 16, { compactPalette: stylePref === 'compact' })
      );
      return;
    }
    wrap.removeAttribute('data-compact');

    if (stylePref === 'compact') {
      const iconSize = syncCompactRowGeometry(btn);
      const ringBtn = document.createElement('button');
      ringBtn.type = 'button';
      ringBtn.className = isFetching ? 'ag-qb-compact-ring-btn ag-qb-spinning' : 'ag-qb-compact-ring-btn';
      const ringTip = isZh ? '点击刷新模型配额' : 'Click to refresh quotas';
      ringBtn.setAttribute('aria-label', ringTip);
      ringBtn.title = ringTip;
      ringBtn.style.width = `${iconSize}px`;
      ringBtn.style.height = `${iconSize}px`;
      ringBtn.appendChild(
        buildRingSvg(compactModel.outerPct, compactModel.innerPct, iconSize, { compactPalette: true })
      );
      ringBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void fetchQuota(true);
      });

      const textSpan = document.createElement('span');
      textSpan.className = 'ag-qb-compact-text';
      if (compactModel.segments.length === 0) {
        const statusEl = document.createElement('span');
        statusEl.className = 'ag-qb-compact-val';
        statusEl.setAttribute('data-level', 'muted');
        statusEl.textContent = isFetching
          ? isZh
            ? '配额同步中…'
            : 'Syncing quota…'
          : isZh
            ? '配额待同步'
            : 'Quota pending';
        textSpan.appendChild(statusEl);
      } else {
        for (let i = 0; i < compactModel.segments.length; i++) {
          const item = compactModel.segments[i];
          if (i > 0) {
            const sep = document.createElement('span');
            sep.className = 'ag-qb-compact-sep';
            sep.setAttribute('aria-hidden', 'true');
            sep.textContent = '·';
            textSpan.appendChild(sep);
          }
          const seg = document.createElement('span');
          seg.className = 'ag-qb-compact-seg';
          const kEl = document.createElement('span');
          kEl.className = 'ag-qb-compact-k';
          kEl.textContent = item.key;
          const vEl = document.createElement('span');
          vEl.className = 'ag-qb-compact-val';
          vEl.setAttribute('data-level', levelOfRemaining(item.pct));
          vEl.textContent = item.pct === null ? '--' : `${item.pct}%`;
          seg.appendChild(kEl);
          seg.appendChild(vEl);
          textSpan.appendChild(seg);
        }
      }

      btn.appendChild(ringBtn);
      btn.appendChild(textSpan);
      return;
    }

    resetSidebarBtnInlineStyle(btn);

    const appendResetLine = () => {
      const statusInfo = formatSidebarResetStatus({
        remWeekly,
        resetWeeklySec: weekBucket?.resetSec ?? null,
        rem5h,
        reset5hSec,
        prefer5h: getReset5hPref(),
        nowMs,
        isLoading: isFetching,
        hasError,
        hasData: quotaState.groups.length > 0,
        isZh
      });
      if (!statusInfo) return;
      const sub = document.createElement('div');
      sub.className = 'ag-qb-sub-reset';
      if (statusInfo.secondaryText) {
        sub.setAttribute('data-dual', '1');
        const s1 = document.createElement('span');
        s1.setAttribute('data-level', statusInfo.level || 'muted');
        s1.textContent = statusInfo.text;
        const sep = document.createElement('span');
        sep.className = 'ag-qb-sub-sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '|';
        const s2 = document.createElement('span');
        s2.setAttribute('data-level', statusInfo.secondaryLevel || 'muted');
        s2.textContent = statusInfo.secondaryText;
        sub.appendChild(s1);
        sub.appendChild(sep);
        sub.appendChild(s2);
      } else {
        sub.setAttribute('data-level', statusInfo.level || 'muted');
        sub.textContent = statusInfo.text;
      }
      btn.appendChild(sub);
    };

    if (stylePref === 'ring') {
      const pair = document.createElement('div');
      pair.className = 'ag-qb-ring-pair';

      const mkCell = (label, pct) => {
        const cell = document.createElement('div');
        cell.className = 'ag-qb-ring-cell';
        cell.appendChild(buildRingSvg(pct, null, 22));
        const meta = document.createElement('div');
        meta.className = 'ag-qb-ring-cell-meta';
        const k = document.createElement('span');
        k.className = 'ag-qb-ring-k';
        k.textContent = label;
        const v = document.createElement('span');
        v.className = 'ag-qb-pct-text';
        v.setAttribute('data-level', levelOfRemaining(pct));
        v.textContent = pct === null ? '--' : `${pct}%`;
        meta.appendChild(k);
        meta.appendChild(v);
        cell.appendChild(meta);
        return cell;
      };

      pair.appendChild(mkCell(isZh ? '周限额' : 'Weekly', remWeekly));
      pair.appendChild(mkCell(isZh ? '5h限额' : '5h', rem5h));
      btn.appendChild(pair);
      appendResetLine();
      return;
    }

    const mkBarRow = (labelText, pct) => {
      const row = document.createElement('div');
      row.className = 'ag-qb-row';
      const lbl = document.createElement('span');
      lbl.className = 'ag-qb-label';
      lbl.textContent = labelText;
      const track = document.createElement('div');
      track.className = 'ag-qb-track';
      const fill = document.createElement('div');
      fill.className = 'ag-qb-fill';
      fill.setAttribute('data-level', levelOfRemaining(pct));
      fill.style.width = `${pct === null ? 0 : Math.max(0, Math.min(100, pct))}%`;
      track.appendChild(fill);
      const pctSpan = document.createElement('span');
      pctSpan.className = 'ag-qb-pct';
      pctSpan.setAttribute('data-level', levelOfRemaining(pct));
      pctSpan.textContent = pct === null ? '--' : `${pct}%`;
      row.appendChild(lbl);
      row.appendChild(track);
      row.appendChild(pctSpan);
      return row;
    };

    btn.appendChild(mkBarRow(isZh ? '周限额' : 'Weekly', remWeekly));
    btn.appendChild(mkBarRow(isZh ? '5h限额' : '5h', rem5h));
    appendResetLine();
  }

  function findTitlebarMountContainer() {
    const segments = document.querySelectorAll('[data-testid="breadcrumb-segment"]');
    for (let i = 0; i < segments.length; i++) {
      const row = segments[i].closest('.agy-layout-vars');
      if (!row || !row.parentElement?.querySelector('[data-testid="pane-titlebar-toolbar"]')) continue;
      const r = row.getBoundingClientRect();
      if (r.width > 0 && r.height >= 20) return row;
    }
    const toolbars = document.querySelectorAll('[data-testid="pane-titlebar-toolbar"]');
    for (let i = 0; i < toolbars.length; i++) {
      const tb = toolbars[i];
      const tbRect = tb.getBoundingClientRect();
      if (tbRect.width <= 0 || tbRect.height < 20) continue;
      const prev = tb.previousElementSibling;
      if (prev && prev.getBoundingClientRect().height >= 20) {
        return prev;
      }
    }
    return null;
  }

  function getIndependentPillLabel(matchedGroup, modelName) {
    const lowModel = String(modelName || '').toLowerCase();
    if (lowModel.includes('argon')) return 'Argon';
    if (lowModel.includes('claude')) return 'Claude';
    if (lowModel.includes('gpt')) return 'GPT';
    return formatShortGroupName(matchedGroup?.displayName);
  }

  function renderTitlebarPill() {
    activeModelLabel = readActiveModelName();
    const globalGroup = findGlobalGroup(quotaState.groups);
    const matchedGroup = matchGroupForModel(quotaState.groups, activeModelLabel, globalGroup);

    if (!matchedGroup || !globalGroup || matchedGroup === globalGroup) {
      document.getElementById(PILL_ID)?.remove();
      return;
    }

    const container = findTitlebarMountContainer();
    if (!container) {
      document.getElementById(PILL_ID)?.remove();
      return;
    }

    let pill = document.getElementById(PILL_ID);
    if (!pill) {
      pill = document.createElement('div');
      pill.id = PILL_ID;
      pill.setAttribute('role', 'button');
      pill.setAttribute('tabindex', '0');
      pill.setAttribute('data-ag-quota-ui', '1');
      pill.setAttribute('aria-expanded', 'false');
    }
    if (pill.parentElement !== container) {
      container.appendChild(pill);
    }
    bindTriggerInteraction(pill, 'titlebar');

    const isZh = isZhLang();
    const stylePref = getStylePref();
    pill.setAttribute('data-style', stylePref);
    if (isFetching) pill.setAttribute('data-loading', '1');
    else pill.removeAttribute('data-loading');

    const weekBucket = getBucketByWindow(matchedGroup, 'weekly');
    const fiveBucket = getBucketByWindow(matchedGroup, '5h');
    const rem5h = fiveBucket ? calcRemainingPct(fiveBucket.remainingFraction, false) : null;
    const remWeekly = weekBucket ? calcRemainingPct(weekBucket.remainingFraction, false) : null;
    const poolName = getIndependentPillLabel(matchedGroup, activeModelLabel);
    const items = [];
    if (weekBucket && remWeekly !== null) {
      items.push({ key: isZh ? '周' : 'W', pct: remWeekly, resetSec: weekBucket.resetSec });
    }
    if (fiveBucket && rem5h !== null) {
      items.push({ key: '5h', pct: rem5h, resetSec: fiveBucket.resetSec });
    }
    if (items.length === 0 && matchedGroup?.buckets?.[0]) {
      const b0 = matchedGroup.buckets[0];
      const p0 = calcRemainingPct(b0.remainingFraction, false);
      if (p0 !== null) {
        items.push({ key: b0.displayName || 'Quota', pct: p0, resetSec: b0.resetSec });
      }
    }
    if (items.length === 0) {
      document.getElementById(PILL_ID)?.remove();
      return;
    }

    const nowMs = Date.now();
    const showCd = rem5h !== null && rem5h <= 25 ? formatCompactCountdown(fiveBucket?.resetSec, nowMs) : '';
    pill.setAttribute(
      'aria-label',
      `${poolName} · ${items.map((it) => `${it.key} ${it.pct}%`).join(' / ')}${showCd ? ` · ${showCd}` : ''}`
    );

    pill.replaceChildren();
    const nameEl = document.createElement('span');
    nameEl.className = 'ag-qb-pill-name';
    nameEl.textContent = poolName;
    pill.appendChild(nameEl);

    if (stylePref === 'ring' || stylePref === 'compact') {
      const useCompactPalette = stylePref === 'compact';
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const itemEl = document.createElement('span');
        itemEl.className = 'ag-qb-pill-item';
        itemEl.appendChild(buildRingSvg(it.pct, null, 14, { compactPalette: useCompactPalette }));
        const tagEl = document.createElement('span');
        tagEl.className = 'ag-qb-pill-tag';
        tagEl.textContent = it.key;
        const pctEl = document.createElement('span');
        pctEl.className = 'ag-qb-pct-text';
        pctEl.setAttribute('data-level', levelOfRemaining(it.pct));
        pctEl.textContent = `${it.pct}%`;
        itemEl.appendChild(tagEl);
        itemEl.appendChild(pctEl);
        pill.appendChild(itemEl);
      }
    } else {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const itemEl = document.createElement('span');
        itemEl.className = 'ag-qb-pill-item';
        const tagEl = document.createElement('span');
        tagEl.className = 'ag-qb-pill-tag';
        tagEl.textContent = it.key;
        const track = document.createElement('div');
        track.className = 'ag-qb-pill-track';
        const fill = document.createElement('div');
        fill.className = 'ag-qb-fill';
        fill.setAttribute('data-level', levelOfRemaining(it.pct));
        fill.style.width = `${Math.max(0, Math.min(100, it.pct))}%`;
        track.appendChild(fill);
        const pctEl = document.createElement('span');
        pctEl.className = 'ag-qb-pct-text';
        pctEl.setAttribute('data-level', levelOfRemaining(it.pct));
        pctEl.textContent = `${it.pct}%`;
        itemEl.appendChild(tagEl);
        itemEl.appendChild(track);
        itemEl.appendChild(pctEl);
        pill.appendChild(itemEl);
      }
    }

    if (showCd) {
      const cdEl = document.createElement('span');
      cdEl.className = 'ag-qb-pill-reset';
      cdEl.textContent = showCd;
      pill.appendChild(cdEl);
    }
  }

  function renderTooltip() {
    if (!tooltipOpen) return;
    const hooks = getHooks();
    try {
      hooks.onTooltipClose?.();
    } catch (e) {}

    let tt = document.getElementById(TOOLTIP_ID);
    if (!tt) {
      tt = document.createElement('div');
      tt.id = TOOLTIP_ID;
      tt.setAttribute('role', 'dialog');
      tt.setAttribute('data-ag-quota-ui', '1');
      tt.addEventListener('mouseenter', cancelHoverClose);
      tt.addEventListener('mouseleave', () => {
        if (!tooltipPinned) scheduleHoverClose();
      });
      document.body?.appendChild(tt);
    }
    tt.setAttribute('data-open', '1');
    tt.setAttribute('data-visible', '1');
    tt.replaceChildren();

    const isZh = isZhLang();
    const nowMs = Date.now();

    const head = document.createElement('div');
    head.className = 'ag-qb-tt-head';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'ag-qb-tt-title-wrap';
    const titleEl = document.createElement('span');
    titleEl.className = 'ag-qb-tt-title';
    titleEl.textContent = isZh ? '模型配额' : 'Model Quotas';
    titleWrap.appendChild(titleEl);

    if (quotaState.account?.tierLabel) {
      const badge = document.createElement('span');
      badge.className = 'ag-qb-tier-badge';
      badge.textContent = quotaState.account.tierLabel;
      titleWrap.appendChild(badge);
    }
    if (quotaState.account?.maskedEmail) {
      const maskEl = document.createElement('span');
      maskEl.className = 'ag-qb-acct-mask';
      maskEl.textContent = quotaState.account.maskedEmail;
      titleWrap.appendChild(maskEl);
    }

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = isFetching ? 'ag-qb-icon-btn ag-qb-spinning' : 'ag-qb-icon-btn';
    refreshBtn.setAttribute('aria-label', isZh ? '刷新配额' : 'Refresh Quotas');
    refreshBtn.title = isZh ? '刷新配额' : 'Refresh Quotas';
    refreshBtn.appendChild(buildRefreshIconSvg());
    refreshBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void fetchQuota(true);
    });

    head.appendChild(titleWrap);
    head.appendChild(refreshBtn);
    tt.appendChild(head);

    if (quotaState.groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ag-qb-tt-empty';
      empty.textContent = isFetching
        ? isZh
          ? '正在读取模型配额...'
          : 'Loading model quotas...'
        : isZh
          ? '暂无配额数据，点击右上角重试'
          : 'No quota data yet. Click refresh to retry.';
      tt.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'ag-qb-pool-list';
      const globalGroup = findGlobalGroup(quotaState.groups);
      const activeGroup = matchGroupForModel(quotaState.groups, activeModelLabel || readActiveModelName(), globalGroup);

      for (let i = 0; i < quotaState.groups.length; i++) {
        const g = quotaState.groups[i];
        const card = document.createElement('div');
        card.className = 'ag-qb-pool-card';
        if (g === activeGroup) card.setAttribute('data-active', '1');

        const gHead = document.createElement('div');
        gHead.className = 'ag-qb-pool-head';
        const gName = document.createElement('span');
        gName.textContent = formatShortGroupName(g.displayName);
        gHead.appendChild(gName);
        if (g === activeGroup) {
          const tag = document.createElement('span');
          tag.className = 'ag-qb-active-tag';
          tag.textContent = isZh ? '当前' : 'Active';
          gHead.appendChild(tag);
        }
        card.appendChild(gHead);

        const stylePref = getStylePref();
        const buckets = [];
        const bWk = getBucketByWindow(g, 'weekly');
        const b5h = getBucketByWindow(g, '5h');
        if (bWk) buckets.push({ bucket: bWk, label: isZh ? '每周限额' : 'Weekly', shortLabel: isZh ? '周限额' : 'Weekly' });
        if (b5h) buckets.push({ bucket: b5h, label: isZh ? '5小时窗口' : '5h Window', shortLabel: isZh ? '5h限额' : '5h' });
        for (let k = 0; k < (g.buckets || []).length; k++) {
          const b = g.buckets[k];
          if (b !== b5h && b !== bWk) {
            const lbl = b.displayName || b.bucketId || 'Limit';
            buckets.push({ bucket: b, label: lbl, shortLabel: lbl });
          }
        }

        if (stylePref === 'ring') {
          const ringGrid = document.createElement('div');
          ringGrid.className = 'ag-qb-tt-ring-grid';
          if (buckets.length === 1) ringGrid.setAttribute('data-cols', '1');

          for (let j = 0; j < buckets.length; j++) {
            const item = buckets[j];
            const pct = calcRemainingPct(item.bucket.remainingFraction, false);
            const pctText = calcRemainingPct(item.bucket.remainingFraction, true);
            const cdText = formatResetCountdown(item.bucket.resetSec, nowMs, isZh);
            const clockText = formatClockTime(item.bucket.resetSec);
            const lvl = levelOfRemaining(pct);

            const cell = document.createElement('div');
            cell.className = 'ag-qb-tt-ring-cell';
            const fullResetDesc = cdText
              ? clockText
                ? isZh
                  ? `${cdText}后 (${clockText})`
                  : `in ${cdText} (${clockText})`
                : isZh
                  ? `${cdText}后重置`
                  : `in ${cdText}`
              : isZh
                ? '已重置'
                : 'Reset';
            cell.title = `${item.label} · ${isZh ? '剩余 ' : ''}${pctText} · ${fullResetDesc}`;
            cell.appendChild(buildRingSvg(pct, null, 28));

            const meta = document.createElement('div');
            meta.className = 'ag-qb-tt-ring-meta';

            const lblEl = document.createElement('div');
            lblEl.className = 'ag-qb-tt-ring-label';
            lblEl.textContent = item.shortLabel;

            const pctEl = document.createElement('div');
            pctEl.className = 'ag-qb-tt-ring-pct';
            pctEl.setAttribute('data-level', lvl);
            pctEl.textContent = pctText;

            const resetEl = document.createElement('div');
            resetEl.className = 'ag-qb-tt-ring-reset';
            resetEl.textContent = cdText
              ? isZh
                ? `${cdText}后`
                : `${cdText}`
              : clockText || (isZh ? '已重置' : 'Reset');

            meta.appendChild(lblEl);
            meta.appendChild(pctEl);
            meta.appendChild(resetEl);
            cell.appendChild(meta);
            if (typeof hooks.decorateBucketRow === 'function') {
              try {
                hooks.decorateBucketRow(cell, {
                  style: 'ring',
                  group: g,
                  bucket: item.bucket,
                  metaEl: meta,
                  resetEl,
                  account: quotaState.account,
                  rawAccountStatus: cachedRawAccountStatus,
                  isZh
                });
              } catch (e) {}
            }
            ringGrid.appendChild(cell);
          }
          card.appendChild(ringGrid);
        } else {
          for (let j = 0; j < buckets.length; j++) {
            const item = buckets[j];
            const pct = calcRemainingPct(item.bucket.remainingFraction, false);
            const pctText = calcRemainingPct(item.bucket.remainingFraction, true);
            const cdText = formatResetCountdown(item.bucket.resetSec, nowMs, isZh);
            const clockText = formatClockTime(item.bucket.resetSec);
            const lvl = levelOfRemaining(pct);

            const dRow = document.createElement('div');
            dRow.className = 'ag-qb-detail-row';

            const dTop = document.createElement('div');
            dTop.className = 'ag-qb-detail-top';
            const dk = document.createElement('span');
            dk.className = 'ag-qb-detail-k';
            dk.textContent = item.label;

            const dv = document.createElement('span');
            dv.className = 'ag-qb-detail-v';
            dv.setAttribute('data-level', lvl);
            dv.textContent = `${isZh ? '剩余 ' : ''}${pctText}`;
            dTop.appendChild(dk);
            dTop.appendChild(dv);

            const dTrack = document.createElement('div');
            dTrack.className = 'ag-qb-detail-track';
            const dFill = document.createElement('div');
            dFill.className = 'ag-qb-fill';
            dFill.setAttribute('data-level', lvl);
            dFill.style.width = `${pct === null ? 0 : Math.max(0, Math.min(100, pct))}%`;
            dTrack.appendChild(dFill);

            dRow.appendChild(dTop);
            dRow.appendChild(dTrack);

            let dReset = null;
            if (cdText || clockText) {
              dReset = document.createElement('div');
              dReset.className = 'ag-qb-detail-reset';
              if (cdText && clockText) {
                dReset.textContent = isZh ? `${cdText}后重置 (${clockText})` : `Resets in ${cdText} (${clockText})`;
              } else if (cdText) {
                dReset.textContent = isZh ? `${cdText}后重置` : `Resets in ${cdText}`;
              } else {
                dReset.textContent = clockText;
              }
              dRow.appendChild(dReset);
            }

            if (typeof hooks.decorateBucketRow === 'function') {
              try {
                hooks.decorateBucketRow(dRow, {
                  style: 'bar',
                  group: g,
                  bucket: item.bucket,
                  resetEl: dReset,
                  account: quotaState.account,
                  rawAccountStatus: cachedRawAccountStatus,
                  isZh
                });
              } catch (e) {}
            }

            card.appendChild(dRow);
          }
        }
        list.appendChild(card);
      }
      tt.appendChild(list);
    }

    const foot = document.createElement('div');
    foot.className = 'ag-qb-tt-foot';
    const updEl = document.createElement('span');
    updEl.textContent = formatUpdatedClock(quotaState.updatedAtSec, nowMs, isZh) || (isZh ? '实时同步' : 'Live');
    foot.appendChild(updEl);

    const actions = document.createElement('div');
    actions.className = 'ag-qb-tt-actions';

    const modelsBtn = document.createElement('button');
    modelsBtn.type = 'button';
    modelsBtn.className = 'ag-qb-link-btn';
    modelsBtn.textContent = isZh ? '模型与用量' : 'Models & Usage';
    modelsBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeTooltip();
      openModelsSettingsTab();
    });
    actions.appendChild(modelsBtn);

    let hasTokenTabBtn = false;
    if (ctx?.modules?.tokenAnalytics !== false && typeof window.__ag_open_token_analytics_tab === 'function') {
      const taBtn = document.createElement('button');
      taBtn.type = 'button';
      taBtn.className = 'ag-qb-link-btn';
      taBtn.setAttribute('data-ag-qb-token-btn', '1');
      taBtn.textContent = isZh ? 'Token 统计' : 'Token Stats';
      taBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeTooltip();
        try {
          window.__ag_open_token_analytics_tab();
        } catch (e) {}
      });
      actions.appendChild(taBtn);
      hasTokenTabBtn = true;
    }

    foot.appendChild(actions);
    tt.appendChild(foot);

    if (typeof hooks.renderTooltipFooter === 'function') {
      try {
        hooks.renderTooltipFooter(foot, {
          actionsEl: actions,
          closeTooltip,
          isZh,
          hasTokenTabBtn
        });
      } catch (e) {}
    }
  }

  function renderAll() {
    if (disposed || ctx?.config?.enabled === false || ctx?.modules?.quotaBar === false) return;
    renderSidebarWidget();
    renderTitlebarPill();
    if (tooltipOpen) {
      renderTooltip();
      handleWindowResize();
    }
  }

  function schedulePostTurnRefresh() {
    if (disposed) return;
    if (Date.now() - lastPostTurnRefreshMs < 10000) return;
    lastPostTurnRefreshMs = Date.now();
    if (postTurnTimer) clearTimeout(postTurnTimer);
    postTurnTimer = setTimeout(() => {
      postTurnTimer = null;
      if (!disposed) void fetchQuota(false);
    }, 1200);
  }

  function pollRuntimeSignals() {
    if (disposed || document.hidden || document.visibilityState !== 'visible') return;
    const hasCancelBtn = Boolean(document.querySelector('[data-testid="input-cancel-button"]'));
    const curMetricsSig = String(window.__ag_last_metrics?.sig || ctx?.metrics?.sig || '');
    const sigRes = detectTurnFinishedSignal(turnWatchState, {
      hasCancelBtn,
      metricsSig: curMetricsSig
    });
    turnWatchState = sigRes.nextState;
    if (sigRes.triggered) {
      schedulePostTurnRefresh();
    }

    if (document.querySelector('.settings-modal-container')) {
      ensureAppearanceQuotaSettingsRows();
    }

    const curModel = readActiveModelName();
    if (curModel !== activeModelLabel || !document.getElementById(SIDEBAR_WRAP_ID)) {
      renderAll();
    }

    if (!initialHookSynced && quotaState.groups.length > 0 && typeof getHooks().onQuotaUpdated === 'function') {
      initialHookSynced = true;
      void (async () => {
        if (!accountMetaResolved) {
          const svcs = findFrontendServices();
          if (svcs?.authService) {
            await resolveAccountMetadata(svcs.authService, false);
          }
        }
        if (!disposed) notifyQuotaUpdatedHook(null);
      })();
    }
  }

  function scheduleSettingsRowsSync() {
    if (settingsRowTimer) {
      clearTimeout(settingsRowTimer);
      settingsRowTimer = null;
    }
    let checks = 0;
    const tick = () => {
      if (disposed) return;
      const mounted = ensureAppearanceQuotaSettingsRows();
      if (mounted) {
        syncAppearanceQuotaSettingsRows();
        renderAll();
      }
      if (!mounted && ++checks < 8) {
        settingsRowTimer = setTimeout(tick, 120);
      } else {
        settingsRowTimer = null;
      }
    };
    settingsRowTimer = setTimeout(tick, 50);
  }

  function handleDocumentPointerDown(ev) {
    if (!tooltipOpen) return;
    const target = ev.target;
    if (!(target instanceof Element)) {
      closeTooltip();
      return;
    }
    if (target.closest(`#${TOOLTIP_ID}, #${SIDEBAR_BTN_ID}, #${PILL_ID}, #ag-quota-est-popover`)) return;
    closeTooltip();
  }

  function handleDocumentKeydown(ev) {
    if (ev.key === 'Escape' && tooltipOpen) {
      closeTooltip();
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === ',') {
      scheduleSettingsRowsSync();
    }
  }

  function handleDocumentClick(ev) {
    if (disposed) return;
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-testid="model-selector-trigger"], [role="menuitem"], [role="option"], [data-testid="conversation-row-sidebar"], [data-testid="conversation-row-history"]')) {
      if (modelSyncTimer) clearTimeout(modelSyncTimer);
      modelSyncTimer = setTimeout(() => {
        modelSyncTimer = null;
        renderAll();
      }, 250);
    }
    if (target.closest('[data-testid="settings-button"], [data-testid^="settings-nav-item-"], [data-ag-lang-btn]')) {
      scheduleSettingsRowsSync();
    }
  }

  function handleStorageSync(ev) {
    if (disposed || !ev) return;
    if (ev.key === PREFS_STORAGE_KEY && ev.newValue) {
      try {
        const parsedPrefs = JSON.parse(ev.newValue);
        if (parsedPrefs && typeof parsedPrefs === 'object') {
          setQuotaBarPrefs(parsedPrefs, false);
        }
      } catch (e) {}
      return;
    }
    if (ev.key !== STORAGE_KEY || !ev.newValue) return;
    const nextCached = readCacheFromStorage();
    if (nextCached && nextCached.updatedAtSec >= quotaState.updatedAtSec) {
      quotaState = nextCached;
      const syncedAtMs = nextCached.updatedAtSec ? nextCached.updatedAtSec * 1000 : Date.now();
      lastFetchMs = Math.max(lastFetchMs, syncedAtMs);
      hasError = false;
      renderAll();
      notifyQuotaUpdatedHook(null);
    }
  }

  function handleVisibilityChange() {
    if (disposed || document.hidden || document.visibilityState !== 'visible') return;
    adoptFreshStorageCacheIfNewer();
    renderAll();
    if (Date.now() - lastFetchMs >= POLL_INTERVAL_MS) {
      void fetchQuota(false);
    }
  }

  function handleWindowResize() {
    if (!tooltipOpen) return;
    const anchorEl =
      tooltipAnchorKind === 'titlebar' ? document.getElementById(PILL_ID) : document.getElementById(SIDEBAR_BTN_ID);
    if (anchorEl) positionTooltip(anchorEl, tooltipAnchorKind);
  }

  function checkExpiredWindowsAndFetch() {
    adoptFreshStorageCacheIfNewer();
    const nowSec = Math.floor(Date.now() / 1000);
    const hasExpired = quotaState.groups.some((g) =>
      (g.buckets || []).some((b) => typeof b.resetSec === 'number' && b.resetSec > 0 && b.resetSec <= nowSec)
    );
    if (quotaState.groups.length === 0 || hasExpired || Date.now() - lastFetchMs >= POLL_INTERVAL_MS) {
      void fetchQuota(false);
    }
  }

  function cleanupQuotaBarDom() {
    try {
      document.getElementById(SIDEBAR_WRAP_ID)?.remove();
      document.getElementById(PILL_ID)?.remove();
      document.getElementById(TOOLTIP_ID)?.remove();
      document
        .querySelectorAll('[data-ag-quota-style-row="1"], [data-ag-quota-click-row="1"], [data-ag-quota-reset5h-row="1"]')
        .forEach((el) => el.remove());
    } catch (e) {}
  }

  function teardownQuotaBar() {
    disposed = true;
    hideOptTooltip();
    if (coldBootTimer) clearTimeout(coldBootTimer);
    if (initialHookTimer) clearTimeout(initialHookTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (stateWatcherTimer) clearInterval(stateWatcherTimer);
    if (hoverCloseTimer) clearTimeout(hoverCloseTimer);
    if (modelSyncTimer) clearTimeout(modelSyncTimer);
    if (postTurnTimer) clearTimeout(postTurnTimer);
    if (settingsPollTimer) clearTimeout(settingsPollTimer);
    if (settingsRowTimer) clearTimeout(settingsRowTimer);
    coldBootTimer =
      initialHookTimer =
      pollTimer =
      stateWatcherTimer =
      hoverCloseTimer =
      modelSyncTimer =
      postTurnTimer =
      settingsPollTimer =
      settingsRowTimer =
        null;
    if (sidebarResizeObserver) {
      try {
        sidebarResizeObserver.disconnect();
      } catch (e) {}
      sidebarResizeObserver = null;
    }
    if (authSubDisposable && typeof authSubDisposable.dispose === 'function') {
      try {
        authSubDisposable.dispose();
      } catch (e) {}
    } else if (typeof authSubDisposable === 'function') {
      try {
        authSubDisposable();
      } catch (e) {}
    }
    authSubDisposable = null;
    observedSidebarEl = null;
    document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
    document.removeEventListener('keydown', handleDocumentKeydown, true);
    document.removeEventListener('click', handleDocumentClick, true);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('storage', handleStorageSync);
    window.removeEventListener('popstate', renderAll);
    window.removeEventListener('resize', handleWindowResize);
    window.removeEventListener('blur', closeTooltip);
    cleanupQuotaBarDom();
    try {
      delete window.__ag_rerender_quota_bar_fn;
      delete window.__ag_sync_quota_bar_fn;
      delete window.__ag_teardown_quota_bar_fn;
      delete window.__ag_set_quota_prefs_fn;
    } catch (e) {
      window.__ag_rerender_quota_bar_fn = null;
      window.__ag_sync_quota_bar_fn = null;
      window.__ag_teardown_quota_bar_fn = null;
      window.__ag_set_quota_prefs_fn = null;
    }
  }

  window.__ag_teardown_quota_bar_fn = teardownQuotaBar;
  window.__ag_rerender_quota_bar_fn = () => {
    if (!disposed) renderAll();
  };
  window.__ag_sync_quota_bar_fn = () => {
    if (disposed) return;
    ensureAppearanceQuotaSettingsRows();
    renderAll();
    if (quotaState.groups.length === 0 && !isFetching) {
      void fetchQuota(false);
    }
  };
  window.__ag_set_quota_prefs_fn = setQuotaBarPrefs;

  const initialCache = readCacheFromStorage();
  if (initialCache) {
    quotaState = initialCache;
    lastFetchMs = initialCache.updatedAtSec ? initialCache.updatedAtSec * 1000 : 0;
  }

  const initMetricsSig = String(window.__ag_last_metrics?.sig || ctx?.metrics?.sig || '');
  turnWatchState = {
    wasCancelBtnVisible: Boolean(document.querySelector('[data-testid="input-cancel-button"]')),
    lastMetricsSig: initMetricsSig !== '' ? initMetricsSig : null
  };

  document.addEventListener('pointerdown', handleDocumentPointerDown, true);
  document.addEventListener('mousedown', handleDocumentPointerDown, true);
  document.addEventListener('keydown', handleDocumentKeydown, true);
  document.addEventListener('click', handleDocumentClick, true);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('storage', handleStorageSync);
  window.addEventListener('popstate', renderAll);
  window.addEventListener('resize', handleWindowResize);
  window.addEventListener('blur', closeTooltip);

  stateWatcherTimer = setInterval(pollRuntimeSignals, STATE_WATCH_INTERVAL_MS);

  pollTimer = setInterval(() => {
    if (disposed || document.hidden || document.visibilityState !== 'visible') return;
    adoptFreshStorageCacheIfNewer();
    if (Date.now() - lastFetchMs >= POLL_INTERVAL_MS - 5000) {
      void fetchQuota(false);
    } else {
      renderAll();
    }
  }, POLL_INTERVAL_MS);

  if (typeof ctx?.onCleanup === 'function') {
    ctx.onCleanup(teardownQuotaBar);
  } else if (Array.isArray(window.__ag_cleanup_fns)) {
    window.__ag_cleanup_fns.push(teardownQuotaBar);
  }

  if (document.body) {
    ensureAppearanceQuotaSettingsRows();
    renderAll();
    checkExpiredWindowsAndFetch();
    if (quotaState.groups.length > 0) {
      initialHookTimer = setTimeout(() => {
        initialHookTimer = null;
        if (!disposed && !initialHookSynced && typeof getHooks().onQuotaUpdated === 'function') {
          initialHookSynced = true;
          void (async () => {
            if (!accountMetaResolved) {
              const svcs = findFrontendServices();
              if (svcs?.authService) {
                await resolveAccountMetadata(svcs.authService, false);
              }
            }
            if (!disposed) notifyQuotaUpdatedHook(null);
          })();
        }
      }, 50);
    }
  }
})(typeof ctx !== 'undefined' ? ctx : undefined);
