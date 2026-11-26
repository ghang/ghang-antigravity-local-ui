/**
 * ghang-antigravity-local-ui — Standalone user/custom.js module (Remote Metrics Fallback)
 *
 * Fallback for Remote SSH / remote-server Antigravity windows where the conversation SQLite
 * (<cascadeId>.db) resides on the remote host rather than locally.
 *
 * Behavior:
 * - Zero overhead on local windows: never scans React Fiber or polls unless chuanban's daemon
 *   explicitly reports `dbFound: false` for an active conversation.
 * - Reads trajectory generator metadata & steps strictly read-only via in-page `authService._lsClient`
 *   and feeds identical payloads into `window.__ag_render_metrics(payload)`.
 * - Zero core/daemon.mjs edits, zero MutationObserver, full cleanup via ctx.onCleanup.
 */
((ctx) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.top !== window) return;
  if (window.location && String(window.location.protocol || '').startsWith('plugin:')) return;
  if (ctx?.config?.enabled === false) return;
  if (ctx?.modules?.metrics === false) return;

  if (typeof window.__ag_teardown_remote_metrics_fn === 'function') {
    try {
      window.__ag_teardown_remote_metrics_fn();
    } catch (e) {}
  }

  const CASCADE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const WATCH_INTERVAL_MS = 1500;
  const STREAMING_POLL_MS = 2500;
  const IDLE_POLL_MS = 15000;
  const STEP_PAGE_SIZE = 2000;
  const MAX_STEP_PAGES = 10;

  /* REMOTE_METRICS_LOGIC_START */
  function toNum(v) {
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string') {
      const s = v.endsWith('n') ? v.slice(0, -1) : v;
      const n = Number(s);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  function parseDurationSec(dur) {
    if (!dur || typeof dur !== 'object') return 0;
    return toNum(dur.seconds) + toNum(dur.nanos) / 1e9;
  }

  function fmtTok(n) {
    if (!n || n <= 0) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
    if (n >= 10000) return Math.round(n / 1000) + 'k';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function fmtNum(n) {
    return (n || 0).toLocaleString('en-US');
  }

  function formatContextCeiling(tokens) {
    if (tokens >= 1000000) {
      return `${Number((tokens / 1000000).toFixed(1))}M`;
    }
    return `${Math.round(tokens / 1000)}k`;
  }

  function parseGeneratorMetadataItem(entry, idx) {
    if (!entry || typeof entry !== 'object') return null;
    let chat = null;
    if (entry.metadata && entry.metadata.case === 'chatModel' && entry.metadata.value) {
      chat = entry.metadata.value;
    } else if (entry.chatModel && typeof entry.chatModel === 'object') {
      chat = entry.chatModel;
    } else if (entry.metadata?.chatModel && typeof entry.metadata.chatModel === 'object') {
      chat = entry.metadata.chatModel;
    }
    if (!chat || typeof chat !== 'object') return null;

    const usage = chat.usage && typeof chat.usage === 'object' ? chat.usage : {};
    const ctxWin =
      chat.chatStartMetadata?.contextWindowMetadata &&
      typeof chat.chatStartMetadata.contextWindowMetadata === 'object'
        ? chat.chatStartMetadata.contextWindowMetadata
        : {};

    const inTok = toNum(usage.inputTokens);
    const outTok = toNum(usage.outputTokens);
    const cacheRead = toNum(usage.cacheReadTokens);
    const apiProvider = toNum(usage.apiProvider);
    const thinkTok = toNum(usage.thinkingOutputTokens);
    const respTok = toNum(usage.responseOutputTokens);
    const estCtx = toNum(ctxWin.estimatedTokensUsed);
    const maxCtx = toNum(ctxWin.maxContextTokens);
    const slug = String(chat.responseModel || chat.modelSlug || '');
    const hasThinkField =
      usage.thinkingOutputTokens !== undefined &&
      usage.thinkingOutputTokens !== null &&
      thinkTok > 0;
    const thinkUnreported =
      !hasThinkField && thinkTok === 0 && (apiProvider === 26 || /^claude-/i.test(slug));
    const ttft = parseDurationSec(chat.timeToFirstToken);
    const stream = parseDurationSec(chat.streamingDuration);

    return {
      idx,
      inTok,
      outTok,
      cacheRead,
      ctx: inTok + cacheRead,
      estCtx,
      maxCtx,
      thinkTok,
      respTok,
      thinkUnreported,
      ttft,
      stream,
      totDur: ttft + stream
    };
  }

  function classifyStep(step) {
    if (!step || typeof step !== 'object') return 'other';
    const t = step.type;
    const c = step.step?.case || '';
    if (t === 14 || t === 'CORTEX_STEP_TYPE_USER_INPUT' || c === 'userInput') {
      return 'user';
    }
    if (t === 15 || t === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || c === 'plannerResponse') {
      return 'planner';
    }
    if (t === 101 || t === 'CORTEX_STEP_TYPE_SEND_MESSAGE' || c === 'sendMessage') {
      let text = '';
      try {
        text = JSON.stringify(step.step || step.metadata || '');
      } catch (e) {
        text = '';
      }
      if (text.includes('[Message]') && !text.includes('/task-') && !text.includes('sender=system')) {
        return 'wake';
      }
    }
    return 'other';
  }

  function createStepTurnState() {
    return {
      totalSteps: 0,
      userStepsCount: 0,
      lastUserStepIdx: -1,
      wakeStepsCount: 0,
      lastWakeStepIdx: -1,
      prevWasWake: false,
      plannerAfterLastUser: 0,
      plannerAfterLastWake: 0
    };
  }

  function accumulateSteps(state, steps, startIndex = 0) {
    const arr = Array.isArray(steps) ? steps : [];
    for (let i = 0; i < arr.length; i++) {
      const idx = startIndex + i;
      if (idx < state.totalSteps) continue;
      const kind = classifyStep(arr[i]);
      if (kind === 'user') {
        state.userStepsCount += 1;
        state.lastUserStepIdx = idx;
        state.plannerAfterLastUser = 0;
        state.prevWasWake = false;
      } else if (kind === 'wake') {
        if (!state.prevWasWake) {
          state.wakeStepsCount += 1;
        }
        state.lastWakeStepIdx = idx;
        state.plannerAfterLastWake = 0;
        state.prevWasWake = true;
      } else {
        if (kind === 'planner') {
          state.plannerAfterLastUser += 1;
          state.plannerAfterLastWake += 1;
        }
        state.prevWasWake = false;
      }
      state.totalSteps = idx + 1;
    }
    const isSubagentWakeTurns = state.userStepsCount === 0;
    const effectiveTurnsCount = isSubagentWakeTurns
      ? state.wakeStepsCount > 0
        ? state.wakeStepsCount
        : 1
      : state.userStepsCount;
    const rawTurnSteps = isSubagentWakeTurns ? state.plannerAfterLastWake : state.plannerAfterLastUser;
    return {
      isSubagentWakeTurns,
      effectiveTurnsCount,
      rawTurnSteps
    };
  }

  function createGenIncState() {
    return {
      fetchedCount: 0,
      items: [],
      validItems: [],
      totalIn: 0,
      totalCache: 0,
      totalOut: 0,
      totalThink: 0,
      totalResp: 0
    };
  }

  function mergeGenMetadataDelta(inc, rawEntries, offset = 0) {
    const entries = Array.isArray(rawEntries) ? rawEntries : [];
    while (inc.items.length > 0 && inc.items[inc.items.length - 1].idx >= offset) {
      const popped = inc.items.pop();
      inc.totalIn -= popped.inTok;
      inc.totalCache -= popped.cacheRead;
      inc.totalOut -= popped.outTok;
      inc.totalThink -= popped.thinkTok;
      inc.totalResp -= popped.respTok;
    }
    while (inc.validItems.length > 0 && inc.validItems[inc.validItems.length - 1].idx >= offset) {
      inc.validItems.pop();
    }
    for (let i = 0; i < entries.length; i++) {
      const idx = offset + i;
      const p = parseGeneratorMetadataItem(entries[i], idx);
      if (!p) continue;
      inc.items.push(p);
      inc.totalIn += p.inTok;
      inc.totalCache += p.cacheRead;
      inc.totalOut += p.outTok;
      inc.totalThink += p.thinkTok;
      inc.totalResp += p.respTok;
      if (p.ctx > 0 || p.outTok > 0) {
        inc.validItems.push(p);
      }
    }
    inc.fetchedCount = offset + entries.length;
    return inc;
  }

  function buildMetricsPayload({
    cascadeId,
    inc,
    userStepsCount,
    isSubagentWakeTurns,
    rawTurnSteps,
    config = {},
    isEnMetrics = false,
    stepCount = 0
  }) {
    const valid = inc?.validItems || [];
    if (valid.length === 0) {
      return {
        cascadeId,
        hasData: false,
        dbFound: false,
        __agRemoteFallback: true
      };
    }

    const totalIn = inc.totalIn || 0;
    const totalCache = inc.totalCache || 0;
    const totalOut = inc.totalOut || 0;
    const totalThink = inc.totalThink || 0;
    const totalResp = inc.totalResp || 0;

    const turnSlice = rawTurnSteps > 0 ? valid.slice(-rawTurnSteps) : [];
    const turnSteps = turnSlice.length;
    let turnIn = 0;
    let turnOut = 0;
    let turnThink = 0;
    let turnResp = 0;
    let turnDur = 0;
    let turnAllThinkUnreported = turnSlice.length > 0;
    for (let i = 0; i < turnSlice.length; i++) {
      turnIn += turnSlice[i].inTok;
      turnOut += turnSlice[i].outTok;
      turnThink += turnSlice[i].thinkTok;
      turnResp += turnSlice[i].respTok;
      turnDur += turnSlice[i].totDur;
      if (!turnSlice[i].thinkUnreported || turnSlice[i].thinkTok > 0) {
        turnAllThinkUnreported = false;
      }
    }

    let sessionAllThinkUnreported = totalThink === 0 && valid.length > 0;
    if (sessionAllThinkUnreported) {
      for (let i = 0; i < valid.length; i++) {
        if (!valid[i].thinkUnreported) {
          sessionAllThinkUnreported = false;
          break;
        }
      }
    }

    const last = valid[valid.length - 1];
    const fallbackContextLimit = Number(config.contextLimit) > 0 ? Number(config.contextLimit) : 256000;
    const overrideLimit = Number(config.contextLimitOverride) > 0 ? Number(config.contextLimitOverride) : 0;
    const contextLimitTokens =
      overrideLimit > 0 ? overrideLimit : last.maxCtx > 0 ? last.maxCtx : fallbackContextLimit;
    const limitStr = formatContextCeiling(contextLimitTokens);

    const rawStreamTps = last.stream >= 0.5 ? last.outTok / last.stream : 0;
    const e2eTps = last.totDur > 0 ? last.outTok / last.totDur : 0;
    const streamRatio = last.totDur > 0 ? last.stream / last.totDur : 0;
    const useStream =
      rawStreamTps > 0 &&
      rawStreamTps <= 600 &&
      (streamRatio >= 0.15 || (last.stream >= 2.0 && rawStreamTps <= 250));
    const displayTps = useStream ? rawStreamTps : e2eTps;
    const ctxPct = Math.round((last.ctx / contextLimitTokens) * 100);
    const ctxClass = ctxPct >= 90 ? 'ag-ctx-crit' : ctxPct >= 75 ? 'ag-ctx-warn' : 'ag-ctx-ok';
    const lastCacheRate = last.ctx > 0 ? ((last.cacheRead / last.ctx) * 100).toFixed(1) : '0.0';
    const sessionCacheRate =
      totalIn + totalCache > 0 ? ((totalCache / (totalIn + totalCache)) * 100).toFixed(1) : '0.0';
    const remainCtx = Math.max(0, contextLimitTokens - last.ctx);

    const isFullMetrics = String(config.metricsMode || 'compact').trim().toLowerCase() === 'full';
    const turnsUnitEn = isSubagentWakeTurns
      ? userStepsCount === 1
        ? 'wake'
        : 'wakes'
      : userStepsCount === 1
        ? 'turn'
        : 'turns';
    const turnsUnitZh = isSubagentWakeTurns ? '次唤醒' : '轮提问';

    let inlineHtml = '';
    let tooltipHtml = '';

    if (isFullMetrics) {
      inlineHtml = [
        `<span>${Math.round(displayTps)} tok/s</span>`,
        `<span class="ag-sep">·</span>`,
        `<span>${useStream ? 'TTFT' : 'Hold'} ${last.ttft.toFixed(1)}s</span>`,
        `<span class="ag-sep">·</span>`,
        `<span>Ctx ${fmtTok(last.ctx)}/${limitStr} <span class="${ctxClass}">(${ctxPct}%)</span></span>`,
        `<span class="ag-sep">·</span>`,
        `<span>Out ${fmtTok(last.outTok)}</span>`
      ].join('');

      const turnOutDetailEn = turnAllThinkUnreported
        ? `Out ${fmtNum(turnOut)} (Think+Resp merged)`
        : `Out ${fmtNum(turnOut)} (Think ${fmtNum(turnThink)} + Resp ${fmtNum(turnResp)})`;
      const turnOutDetailZh = turnAllThinkUnreported
        ? `输出 ${fmtNum(turnOut)} (含思考链)`
        : `输出 ${fmtNum(turnOut)} (思考 ${fmtNum(turnThink)} + 响应 ${fmtNum(turnResp)})`;
      const turnRowHtml =
        turnSteps > 1
          ? isEnMetrics
            ? `<div class="ag-tt-row"><span class="ag-tt-lbl">Turn Total (${turnSteps} steps)</span><span class="ag-tt-val">${turnOutDetailEn} | ${turnDur.toFixed(1)}s</span></div>`
            : `<div class="ag-tt-row"><span class="ag-tt-lbl">本轮合计 (${turnSteps}步)</span><span class="ag-tt-val">${turnOutDetailZh} | 耗时 ${turnDur.toFixed(1)}s</span></div>`
          : '';
      const outputRowHtml = sessionAllThinkUnreported
        ? isEnMetrics
          ? `<div class="ag-tt-row"><span class="ag-tt-lbl">Total Output</span><span class="ag-tt-val">Total ${fmtTok(totalOut)} (Think+Resp merged)</span></div>`
          : `<div class="ag-tt-row"><span class="ag-tt-lbl">累计输出量</span><span class="ag-tt-val">总计 ${fmtTok(totalOut)} (接口合并计入思考链)</span></div>`
        : isEnMetrics
          ? `<div class="ag-tt-row"><span class="ag-tt-lbl">Total Output</span><span class="ag-tt-val">Total ${fmtTok(totalOut)} (Think ${fmtTok(totalThink)} + Resp ${fmtTok(totalResp)})</span></div>`
          : `<div class="ag-tt-row"><span class="ag-tt-lbl">累计输出量</span><span class="ag-tt-val">总计 ${fmtTok(totalOut)} (思考链 ${fmtTok(totalThink)} + 正文/工具 ${fmtTok(totalResp)})</span></div>`;
      const stepOutValEn = last.thinkUnreported
        ? `${fmtNum(last.outTok)} (Think+Resp merged)`
        : `${fmtNum(last.outTok)} (Think ${fmtNum(last.thinkTok)} + Resp ${fmtNum(last.respTok)})`;
      const stepOutValZh = last.thinkUnreported
        ? `${fmtNum(last.outTok)} (接口合并计入思考链)`
        : `${fmtNum(last.outTok)} (思考链 ${fmtNum(last.thinkTok)} + 正文/工具 ${fmtNum(last.respTok)})`;

      tooltipHtml = isEnMetrics
        ? [
            `<div class="ag-tt-hdr">Latest Call (Gen #${last.idx + 1})</div>`,
            `<div class="ag-tt-row"><span class="ag-tt-lbl">Throughput</span><span class="ag-tt-val">${useStream ? `Stream ${rawStreamTps.toFixed(1)} tok/s | ` : ''}E2E ${e2eTps.toFixed(1)} tok/s</span></div>`,
            `<div class="ag-tt-row"><span class="ag-tt-lbl">Latency</span><span class="ag-tt-val">${useStream ? `TTFT ${last.ttft.toFixed(2)}s | Stream ${last.stream.toFixed(2)}s | Total ${last.totDur.toFixed(2)}s` : `Wait ${last.ttft.toFixed(2)}s | Flush ${last.stream.toFixed(2)}s | Total ${last.totDur.toFixed(2)}s`}</span></div>`,
            `<div class="ag-tt-row"><span class="ag-tt-lbl">Context</span><span class="ag-tt-val">${fmtNum(last.ctx)} (New ${fmtNum(last.inTok)} + Cache ${fmtNum(last.cacheRead)}, ${lastCacheRate}%)</span></div>`,
            `<div class="ag-tt-row"><span class="ag-tt-lbl">Step Output</span><span class="ag-tt-val">${stepOutValEn}</span></div>`,
            turnRowHtml,
            `<div class="ag-tt-hdr ag-tt-sec">Session Total (${userStepsCount} ${turnsUnitEn} / ${valid.length} calls)</div>`,
            `<div class="ag-tt-row"><span class="ag-tt-lbl">Compaction</span><span class="ag-tt-val">${fmtTok(last.ctx)} / ${limitStr} (${ctxPct}%) · ${fmtTok(remainCtx)} left</span></div>`,
            `<div class="ag-tt-row"><span class="ag-tt-lbl">Total Input</span><span class="ag-tt-val">New ${fmtTok(totalIn)} + Cache ${fmtTok(totalCache)} (${sessionCacheRate}% hit)</span></div>`,
            outputRowHtml
          ].join('')
        : [
            `<div class="ag-tt-hdr">本轮最新调用 (Gen #${last.idx + 1})</div>`,
            `<div class="ag-tt-row"><span class="ag-tt-lbl">生成速度</span><span class="ag-tt-val">${useStream ? `流式 ${rawStreamTps.toFixed(1)} tok/s | ` : ''}端到端（含等待） ${e2eTps.toFixed(1)} tok/s</span></div>`,
            `<div class="ag-tt-row"><span class="ag-tt-lbl">响应耗时</span><span class="ag-tt-val">${useStream ? `TTFT ${last.ttft.toFixed(2)}s | 流式 ${last.stream.toFixed(2)}s | 总计 ${last.totDur.toFixed(2)}s` : `等待 ${last.ttft.toFixed(2)}s | 刷出 ${last.stream.toFixed(2)}s | 总计 ${last.totDur.toFixed(2)}s`}</span></div>`,
            `<div class="ag-tt-row"><span class="ag-tt-lbl">当前上下文</span><span class="ag-tt-val">${fmtNum(last.ctx)} (新增 ${fmtNum(last.inTok)} + 缓存 ${fmtNum(last.cacheRead)}, ${lastCacheRate}%)</span></div>`,
            `<div class="ag-tt-row"><span class="ag-tt-lbl">本步输出量</span><span class="ag-tt-val">${stepOutValZh}</span></div>`,
            turnRowHtml,
            `<div class="ag-tt-hdr ag-tt-sec">当前会话累计 (${userStepsCount} ${turnsUnitZh} / ${valid.length} 次有效调用)</div>`,
            `<div class="ag-tt-row"><span class="ag-tt-lbl">压缩水位线</span><span class="ag-tt-val">${fmtTok(last.ctx)} / ${limitStr} (${ctxPct}%) · 距压缩余 ${fmtTok(remainCtx)}</span></div>`,
            `<div class="ag-tt-row"><span class="ag-tt-lbl">累计输入量</span><span class="ag-tt-val">新增 ${fmtTok(totalIn)} + 缓存读取 ${fmtTok(totalCache)} (命中率 ${sessionCacheRate}%)</span></div>`,
            outputRowHtml
          ].join('');
    } else {
      const clampedPct = Math.max(0, Math.min(100, ctxPct));
      const ringVisualPct = last.ctx > 0 && clampedPct < 5 ? 5 : clampedPct;
      const ringCircum = 36.44;
      const ringOffset = (ringCircum * (1 - ringVisualPct / 100)).toFixed(2);
      const ringSvg = `<svg class="ag-ctx-ring ${ctxClass}" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><circle class="ag-ctx-ring-track" cx="8" cy="8" r="5.8" fill="none" stroke-width="2.1"/><circle class="ag-ctx-ring-fill" cx="8" cy="8" r="5.8" fill="none" stroke-width="2.1" stroke-linecap="round" stroke-dasharray="${ringCircum}" stroke-dashoffset="${ringOffset}" transform="rotate(-90 8 8)"/></svg>`;

      inlineHtml = [
        ringSvg,
        `<span class="ag-ring-after">${Math.round(displayTps)} tok/s</span>`,
        `<span class="ag-sep">·</span>`,
        `<span>${useStream ? 'TTFT' : 'Hold'} ${last.ttft.toFixed(1)}s</span>`
      ].join('');

      const turnDisplayNum = userStepsCount > 0 ? userStepsCount : last.idx + 1;
      const effectiveTurnSteps = turnSteps > 0 ? turnSteps : 1;
      const effectiveTurnDur = turnSteps > 0 ? turnDur : last.totDur;
      const turnDurStr =
        effectiveTurnDur >= 10 ? `${Math.round(effectiveTurnDur)}s` : `${effectiveTurnDur.toFixed(1)}s`;

      const effectiveTurnIn = turnSteps > 0 ? turnIn : last.inTok;
      const effectiveTurnOut = turnSteps > 0 ? turnOut : last.outTok;
      const effectiveTurnThink = turnSteps > 0 ? turnThink : last.thinkTok;
      const effectiveTurnResp = turnSteps > 0 ? turnResp : last.respTok;
      const effectiveThinkUnreported = turnSteps > 0 ? turnAllThinkUnreported : Boolean(last.thinkUnreported);
      const splitSum = (effectiveTurnThink || 0) + (effectiveTurnResp || 0);
      const thinkRatioPct = splitSum > 0 ? Math.round(((effectiveTurnThink || 0) / splitSum) * 100) : 0;
      const respRatioPct = 100 - thinkRatioPct;

      const resolveCacheTier = (rateVal) =>
        rateVal >= 95 ? 'good' : rateVal >= 90 ? 'fair' : rateVal >= 50 ? 'low' : 'bad';
      const lastCacheTier = resolveCacheTier(Number(lastCacheRate) || 0);
      const sessionCacheTier = resolveCacheTier(Number(sessionCacheRate) || 0);
      const ctxVolTier = last.ctx > 400000 ? 'bad' : last.ctx >= 200000 ? 'fair' : 'good';

      const compactSplitRowEn = effectiveThinkUnreported
        ? `<div class="ag-tt-row ag-tt-row-merged"><span class="ag-tt-lbl">Output</span><span class="ag-tt-val">${fmtTok(effectiveTurnOut)} <span class="ag-tt-lbl">(Think+Resp merged)</span></span></div>`
        : `<div class="ag-tt-row ag-tt-row-merged"><span class="ag-tt-lbl">Output Split</span><span class="ag-tt-split-group"><span class="ag-tt-split-ratio ag-tt-think-lbl">Think ${thinkRatioPct}%</span><span class="ag-tt-split-track"><span class="ag-tt-split-think" style="width:${thinkRatioPct}%"></span><span class="ag-tt-split-resp" style="width:${respRatioPct}%"></span></span><span class="ag-tt-split-ratio ag-tt-resp-lbl">Resp ${respRatioPct}%</span></span></div>`;
      const compactSplitRowZh = effectiveThinkUnreported
        ? `<div class="ag-tt-row ag-tt-row-merged"><span class="ag-tt-lbl">本轮输出</span><span class="ag-tt-val">${fmtTok(effectiveTurnOut)} <span class="ag-tt-lbl">(接口合并计入思考链)</span></span></div>`
        : `<div class="ag-tt-row ag-tt-row-merged"><span class="ag-tt-lbl">输出比例</span><span class="ag-tt-split-group"><span class="ag-tt-split-ratio ag-tt-think-lbl">思考链 ${thinkRatioPct}%</span><span class="ag-tt-split-track"><span class="ag-tt-split-think" style="width:${thinkRatioPct}%"></span><span class="ag-tt-split-resp" style="width:${respRatioPct}%"></span></span><span class="ag-tt-split-ratio ag-tt-resp-lbl">正文/工具 ${respRatioPct}%</span></span></div>`;
      const turnHdrLabelEn = isSubagentWakeTurns ? `Wake #${turnDisplayNum}` : `Turn #${turnDisplayNum}`;
      const turnHdrLabelZh = isSubagentWakeTurns ? `第${turnDisplayNum}次唤醒` : `第${turnDisplayNum}轮`;

      tooltipHtml = isEnMetrics
        ? [
            `<div class="ag-tt-hdr"><span>Current Turn</span><span class="ag-tt-hdr-meta">${turnHdrLabelEn} · ${effectiveTurnSteps} ${effectiveTurnSteps === 1 ? 'step' : 'steps'} · ${turnDurStr}</span></div>`,
            `<div class="ag-tt-row"><span class="ag-tt-lbl">Throughput</span><span class="ag-tt-val">${useStream ? `Stream ${rawStreamTps.toFixed(1)} tok/s | ` : ''}E2E ${e2eTps.toFixed(1)} tok/s</span></div>`,
            `<div class="ag-tt-row"><span class="ag-tt-lbl">Latency</span><span class="ag-tt-val">${useStream ? `TTFT ${last.ttft.toFixed(2)}s | Stream ${last.stream.toFixed(2)}s | Total ${last.totDur.toFixed(2)}s` : `Wait ${last.ttft.toFixed(2)}s | Flush ${last.stream.toFixed(2)}s | Total ${last.totDur.toFixed(2)}s`}</span></div>`,
            `<div class="ag-tt-row ag-tt-row-merged"><span class="ag-tt-lbl">Net Input</span><span class="ag-tt-compact-right"><span class="ag-tt-val">+${fmtTok(effectiveTurnIn)}</span><span class="ag-tt-cache-tag ag-cache-${lastCacheTier}">Cache ${lastCacheRate}%</span></span></div>`,
            compactSplitRowEn,
            `<div class="ag-tt-hdr ag-tt-sec"><span>Session Total</span><span class="ag-tt-hdr-meta">${userStepsCount} ${turnsUnitEn} / ${valid.length} calls</span></div>`,
            `<div class="ag-tt-row ag-tt-row-merged"><span class="ag-tt-bar-group"><span class="ag-tt-ctx-bar"><span class="ag-tt-ctx-fill ${ctxClass}" style="width:${clampedPct}%"></span></span><span class="ag-tt-bar-lbl ag-tt-num-${ctxVolTier}">${fmtTok(last.ctx)}/${limitStr} (${ctxPct}%)</span></span><span class="ag-tt-nowrap"><span class="ag-tt-lbl">Avg Cache </span><span class="ag-tt-val ag-tt-num-${sessionCacheTier}">${sessionCacheRate}%</span></span></div>`
          ].join('')
        : [
            `<div class="ag-tt-hdr"><span>当前轮次</span><span class="ag-tt-hdr-meta">${turnHdrLabelZh} 总${effectiveTurnSteps}步 共耗时${turnDurStr}</span></div>`,
            `<div class="ag-tt-row"><span class="ag-tt-lbl">生成速度</span><span class="ag-tt-val">${useStream ? `流式 ${rawStreamTps.toFixed(1)} tok/s | ` : ''}端到端 ${e2eTps.toFixed(1)} tok/s</span></div>`,
            `<div class="ag-tt-row"><span class="ag-tt-lbl">响应耗时</span><span class="ag-tt-val">${useStream ? `TTFT ${last.ttft.toFixed(2)}s | 流式 ${last.stream.toFixed(2)}s | 总计 ${last.totDur.toFixed(2)}s` : `等待 ${last.ttft.toFixed(2)}s | 刷出 ${last.stream.toFixed(2)}s | 总计 ${last.totDur.toFixed(2)}s`}</span></div>`,
            `<div class="ag-tt-row ag-tt-row-merged"><span class="ag-tt-lbl">本轮净增</span><span class="ag-tt-compact-right"><span class="ag-tt-val">+${fmtTok(effectiveTurnIn)}</span><span class="ag-tt-cache-tag ag-cache-${lastCacheTier}">缓存率 ${lastCacheRate}%</span></span></div>`,
            compactSplitRowZh,
            `<div class="ag-tt-hdr ag-tt-sec"><span>会话总计</span><span class="ag-tt-hdr-meta">${userStepsCount} ${turnsUnitZh} / ${valid.length} 次调用</span></div>`,
            `<div class="ag-tt-row ag-tt-row-merged"><span class="ag-tt-bar-group"><span class="ag-tt-ctx-bar"><span class="ag-tt-ctx-fill ${ctxClass}" style="width:${clampedPct}%"></span></span><span class="ag-tt-bar-lbl ag-tt-num-${ctxVolTier}">${fmtTok(last.ctx)}/${limitStr} (${ctxPct}%)</span></span><span class="ag-tt-nowrap"><span class="ag-tt-lbl">全轮次平均缓存 </span><span class="ag-tt-val ag-tt-num-${sessionCacheTier}">${sessionCacheRate}%</span></span></div>`
          ].join('');
    }

    return {
      cascadeId,
      hasData: true,
      dbFound: true,
      sig: `remote:${valid.length}:${last.idx}:${last.outTok}:${userStepsCount}:${stepCount}:${isFullMetrics ? 'full' : 'compact'}:${isEnMetrics ? 'en' : 'zh'}`,
      isDraining: false,
      partialStale: false,
      uncBackoffActive: false,
      __agRemoteFallback: true,
      inlineHtml,
      tooltipHtml
    };
  }
  /* REMOTE_METRICS_LOGIC_END */

  let disposed = false;
  let cachedLsClient = null;
  let watchTimer = null;
  let postStreamTimer = null;
  let wasStreaming = false;
  let baseRenderMetrics = null;
  let wrapperRenderMetrics = null;

  const remoteCids = new Set();
  const remoteStateByCid = new Map();

  function resolveIsEnMetrics() {
    return Boolean(
      window.__ag_runtime_ui_lang === 'en' ||
        ctx?.modules?.i18n === false ||
        ctx?.config?.installedLocale === 'none'
    );
  }

  function resolveMetricsConfig() {
    const cfg = ctx?.config || {};
    const rawMode = String(cfg.metricsMode || 'compact').trim().toLowerCase();
    return {
      metricsMode: rawMode === 'full' || rawMode === 'legacy' ? 'full' : 'compact',
      contextLimit: Number(cfg.contextLimit) > 0 ? Number(cfg.contextLimit) : 256000,
      contextLimitOverride: Number(cfg.contextLimitOverride) > 0 ? Number(cfg.contextLimitOverride) : 0
    };
  }

  function buildRenderKey(cfg, isEn) {
    return `${isEn ? 'en' : 'zh'}|${cfg.metricsMode}|${cfg.contextLimit}|${cfg.contextLimitOverride}`;
  }

  function isValidLsClient(ls) {
    return Boolean(
      ls &&
        typeof ls === 'object' &&
        typeof ls.getCascadeTrajectoryGeneratorMetadata === 'function' &&
        typeof ls.getCascadeTrajectorySteps === 'function'
    );
  }

  function findLsClient() {
    if (isValidLsClient(cachedLsClient)) return cachedLsClient;
    const rootEl =
      document.getElementById('root') ||
      document.getElementById('react-app') ||
      document.body?.firstElementChild ||
      null;
    if (!rootEl) return null;

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
      return null;
    }
    if (!rootFiber) return null;

    const visited = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    const queue = [rootFiber];
    let head = 0;
    let steps = 0;
    const MAX_NODES = 6000;
    const START_MS = typeof performance?.now === 'function' ? performance.now() : Date.now();
    let found = null;

    const inspectBag = (obj, depth = 0) => {
      if (found || !obj || typeof obj !== 'object' || depth > 2) return;
      if (isValidLsClient(obj._lsClient)) {
        found = obj._lsClient;
        return;
      }
      if (isValidLsClient(obj.authService?._lsClient)) {
        found = obj.authService._lsClient;
        return;
      }
      if (depth < 2 && obj.core && typeof obj.core === 'object') {
        inspectBag(obj.core, depth + 1);
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
        const elapsed = (typeof performance?.now === 'function' ? performance.now() : Date.now()) - START_MS;
        if (elapsed > 60) break;
      }
      const node = queue[head++];
      if (!node || typeof node !== 'object') continue;
      if (visited) {
        if (visited.has(node)) continue;
        visited.add(node);
      }
      steps += 1;
      try {
        inspectBag(node.memoizedProps, 0);
        if (!found) inspectBag(node.pendingProps, 0);
        if (!found) inspectBag(node.stateNode, 0);
      } catch (e) {}
      if (found) break;
      if (node.child) queue.push(node.child);
      if (node.sibling) queue.push(node.sibling);
      if (node.alternate && (!visited || !visited.has(node.alternate))) queue.push(node.alternate);
    }

    if (found) {
      cachedLsClient = found;
    }
    return found;
  }

  function getOrCreateCidState(cid) {
    let st = remoteStateByCid.get(cid);
    if (!st) {
      st = {
        inc: createGenIncState(),
        stepState: createStepTurnState(),
        turnMeta: { isSubagentWakeTurns: false, effectiveTurnsCount: 1, rawTurnSteps: 0 },
        lastFetchAt: 0,
        lastPayload: null,
        lastRenderKey: '',
        inFlight: null
      };
      remoteStateByCid.set(cid, st);
    }
    return st;
  }

  function deliverPayload(payload) {
    if (disposed || !payload) return;
    if (typeof baseRenderMetrics === 'function') {
      baseRenderMetrics(payload);
    } else if (typeof window.__ag_render_metrics === 'function') {
      window.__ag_render_metrics(payload);
    }
  }

  function rebuildPayloadFromState(cid, st) {
    const cfg = resolveMetricsConfig();
    const isEn = resolveIsEnMetrics();
    const renderKey = buildRenderKey(cfg, isEn);
    const payload = buildMetricsPayload({
      cascadeId: cid,
      inc: st.inc,
      userStepsCount: st.turnMeta.effectiveTurnsCount,
      isSubagentWakeTurns: st.turnMeta.isSubagentWakeTurns,
      rawTurnSteps: st.turnMeta.rawTurnSteps,
      config: cfg,
      isEnMetrics: isEn,
      stepCount: st.stepState.totalSteps
    });
    st.lastRenderKey = renderKey;
    st.lastPayload = payload;
    return payload;
  }

  async function fetchRemoteMetrics(cid, force = false) {
    if (disposed || !CASCADE_UUID_RE.test(cid) || !remoteCids.has(cid)) return null;
    const st = getOrCreateCidState(cid);
    if (st.inFlight) return st.inFlight;
    if (!force && st.lastFetchAt > 0 && Date.now() - st.lastFetchAt < 1000) {
      return st.lastPayload;
    }

    st.inFlight = (async () => {
      try {
        const ls = findLsClient();
        if (!ls) return null;

        let offset = st.inc.fetchedCount > 0 ? st.inc.fetchedCount - 1 : 0;
        let gmRes = await ls.getCascadeTrajectoryGeneratorMetadata({
          cascadeId: cid,
          generatorMetadataOffset: offset
        });
        let entries = Array.isArray(gmRes?.generatorMetadata) ? gmRes.generatorMetadata : [];
        if (offset > 0 && entries.length === 0) {
          st.inc = createGenIncState();
          st.stepState = createStepTurnState();
          offset = 0;
          gmRes = await ls.getCascadeTrajectoryGeneratorMetadata({
            cascadeId: cid,
            generatorMetadataOffset: 0
          });
          entries = Array.isArray(gmRes?.generatorMetadata) ? gmRes.generatorMetadata : [];
        }
        if (disposed || !remoteCids.has(cid)) return null;
        mergeGenMetadataDelta(st.inc, entries, offset);

        let page = 0;
        while (page < MAX_STEP_PAGES) {
          const startIdx = st.stepState.totalSteps;
          const endIdx = startIdx + STEP_PAGE_SIZE;
          const stRes = await ls.getCascadeTrajectorySteps({
            cascadeId: cid,
            startIndex: startIdx,
            endIndex: endIdx
          });
          if (disposed || !remoteCids.has(cid)) return null;
          const chunk = Array.isArray(stRes?.steps) ? stRes.steps : [];
          if (chunk.length > 0) {
            st.turnMeta = accumulateSteps(st.stepState, chunk, startIdx);
          }
          page += 1;
          if (chunk.length < STEP_PAGE_SIZE) break;
        }

        st.lastFetchAt = Date.now();
        const payload = rebuildPayloadFromState(cid, st);
        if (payload.hasData) {
          deliverPayload(payload);
        }
        return payload;
      } catch (e) {
        cachedLsClient = null;
        return null;
      } finally {
        st.inFlight = null;
      }
    })();

    return st.inFlight;
  }

  function handleDbStatusPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const cid = String(payload.cascadeId || '').trim().toLowerCase();
    if (!CASCADE_UUID_RE.test(cid)) return false;

    if (payload.__agRemoteFallback) {
      return false;
    }

    if (payload.dbFound === true) {
      remoteCids.delete(cid);
      remoteStateByCid.delete(cid);
      stopWatcherIfIdle();
      return false;
    }

    if (payload.dbFound === false && !payload.hasData) {
      remoteCids.add(cid);
      ensureWatcherRunning();
      const st = remoteStateByCid.get(cid);
      if (st?.lastPayload?.hasData) {
        const curKey = buildRenderKey(resolveMetricsConfig(), resolveIsEnMetrics());
        const outPayload =
          st.lastRenderKey !== curKey ? rebuildPayloadFromState(cid, st) : st.lastPayload;
        deliverPayload(outPayload);
        if (Date.now() - st.lastFetchAt > WATCH_INTERVAL_MS) {
          void fetchRemoteMetrics(cid, false);
        }
        return true;
      }
      void fetchRemoteMetrics(cid, true);
      return false;
    }

    return false;
  }

  function installRenderMetricsWrapper() {
    const cur = window.__ag_render_metrics;
    if (typeof cur !== 'function') return;
    if (cur.__agRemoteMetricsWrapper) return;
    baseRenderMetrics = cur;
    const wrapped = function (payload) {
      if (handleDbStatusPayload(payload)) {
        return;
      }
      return baseRenderMetrics.call(this, payload);
    };
    wrapped.__agRemoteMetricsWrapper = true;
    wrapped.__agOriginalRenderMetrics = baseRenderMetrics;
    wrapperRenderMetrics = wrapped;
    window.__ag_render_metrics = wrapped;
  }

  function isCidWatched(cid) {
    const list = window.__ag_watched_cascade_ids;
    if (Array.isArray(list)) {
      if (list.length === 0) return false;
      return list.includes(cid);
    }
    const primary = String(window.__ag_watched_cascade_id || '').trim().toLowerCase();
    return !primary || primary === cid;
  }

  function pollRemoteMetricsTick() {
    if (disposed) return;
    installRenderMetricsWrapper();

    if (remoteCids.size === 0) {
      stopWatcherIfIdle();
      return;
    }

    const watchedList = window.__ag_watched_cascade_ids;
    if (Array.isArray(watchedList) && watchedList.length > 0) {
      for (const cid of remoteCids) {
        if (!watchedList.includes(cid)) {
          remoteCids.delete(cid);
          remoteStateByCid.delete(cid);
        }
      }
      if (remoteCids.size === 0) {
        stopWatcherIfIdle();
        return;
      }
    }

    if (document.hidden) return;

    const streaming = Boolean(document.querySelector('[data-testid="input-cancel-button"]'));
    if (wasStreaming && !streaming) {
      if (postStreamTimer) clearTimeout(postStreamTimer);
      postStreamTimer = setTimeout(() => {
        postStreamTimer = null;
        if (disposed || document.hidden) return;
        for (const cid of remoteCids) {
          if (isCidWatched(cid)) {
            void fetchRemoteMetrics(cid, true);
          }
        }
      }, 400);
    }
    wasStreaming = streaming;

    const curKey = buildRenderKey(resolveMetricsConfig(), resolveIsEnMetrics());
    const minAge = streaming ? STREAMING_POLL_MS : IDLE_POLL_MS;
    const now = Date.now();

    for (const cid of remoteCids) {
      if (!isCidWatched(cid)) continue;
      const st = getOrCreateCidState(cid);
      if (st.lastPayload?.hasData && st.lastRenderKey && st.lastRenderKey !== curKey) {
        const rebuilt = rebuildPayloadFromState(cid, st);
        if (rebuilt.hasData) deliverPayload(rebuilt);
      }
      if (now - st.lastFetchAt >= minAge) {
        void fetchRemoteMetrics(cid, streaming);
      }
    }
  }

  function ensureWatcherRunning() {
    if (disposed || watchTimer) return;
    watchTimer = setInterval(pollRemoteMetricsTick, WATCH_INTERVAL_MS);
  }

  function stopWatcherIfIdle() {
    if (remoteCids.size > 0) return;
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    if (postStreamTimer) {
      clearTimeout(postStreamTimer);
      postStreamTimer = null;
    }
    wasStreaming = false;
  }

  function handleVisibilityChange() {
    if (disposed || document.hidden || remoteCids.size === 0) return;
    const now = Date.now();
    for (const cid of remoteCids) {
      if (!isCidWatched(cid)) continue;
      const st = remoteStateByCid.get(cid);
      if (!st || now - st.lastFetchAt > 3000) {
        void fetchRemoteMetrics(cid, true);
      }
    }
  }

  function bootstrapExistingMetrics() {
    const byId = window.__ag_metrics_by_id;
    if (!byId || typeof byId !== 'object') return;
    const watched = Array.isArray(window.__ag_watched_cascade_ids)
      ? window.__ag_watched_cascade_ids
      : Object.keys(byId);
    for (let i = 0; i < watched.length; i++) {
      const cid = String(watched[i] || '').trim().toLowerCase();
      if (!CASCADE_UUID_RE.test(cid)) continue;
      const cached = byId[cid];
      if (cached && cached.dbFound === false && !cached.hasData && !cached.__agRemoteFallback) {
        handleDbStatusPayload(cached);
      }
    }
  }

  function teardownRemoteMetrics() {
    if (disposed) return;
    disposed = true;
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    if (postStreamTimer) {
      clearTimeout(postStreamTimer);
      postStreamTimer = null;
    }
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    if (window.__ag_render_metrics === wrapperRenderMetrics && typeof baseRenderMetrics === 'function') {
      window.__ag_render_metrics = baseRenderMetrics;
    }
    baseRenderMetrics = null;
    wrapperRenderMetrics = null;
    cachedLsClient = null;
    remoteCids.clear();
    remoteStateByCid.clear();
    try {
      delete window.__ag_teardown_remote_metrics_fn;
    } catch (e) {
      window.__ag_teardown_remote_metrics_fn = null;
    }
  }

  window.__ag_teardown_remote_metrics_fn = teardownRemoteMetrics;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  installRenderMetricsWrapper();
  bootstrapExistingMetrics();

  if (typeof ctx?.onCleanup === 'function') {
    ctx.onCleanup(teardownRemoteMetrics);
  } else if (Array.isArray(window.__ag_cleanup_fns)) {
    window.__ag_cleanup_fns.push(teardownRemoteMetrics);
  }
})(typeof ctx !== 'undefined' ? ctx : undefined);
