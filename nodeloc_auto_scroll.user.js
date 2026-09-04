// ==UserScript==
// @name         NodeLoc Auto Scroll & Evidence-Grounded Replier (v21.7.0 - JSON接口直读版)
// @namespace    http://tampermonkey.net/
// @version      21.7.0
// @description  成长指标改用官方 upgrade-progress.json 接口直连获取，彻底告别 DOM 模拟与菜单闪烁；支持自主配置账号与自动感知；延续胶囊全能交互与说人话引擎。
// @author       AutoScroll & shuorenhua
// @match        https://www.nodeloc.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/kavion1/nodeloc-auto-scroll/main/nodeloc_auto_scroll.user.js
// @downloadURL  https://raw.githubusercontent.com/kavion1/nodeloc-auto-scroll/main/nodeloc_auto_scroll.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // Web Worker 独立线程定时器
  // ============================================================
  const WorkerTimer = (() => {
    let worker = null;
    const callbacks = new Map();
    let nextId = 1;

    function initWorker() {
      if (worker) return worker;
      try {
        const blobCode = `
          const activeTimers = new Map();
          self.onmessage = function(e) {
            const { type, id, interval } = e.data;
            if (type === 'setInterval') {
              const tid = setInterval(() => { self.postMessage({ id }); }, interval);
              activeTimers.set(id, tid);
            } else if (type === 'setTimeout') {
              const tid = setTimeout(() => { self.postMessage({ id }); activeTimers.delete(id); }, interval);
              activeTimers.set(id, tid);
            } else if (type === 'clear') {
              const tid = activeTimers.get(id);
              if (tid) { clearInterval(tid); clearTimeout(tid); activeTimers.delete(id); }
            }
          };
        `;
        const blob = new Blob([blobCode], { type: 'application/javascript' });
        worker = new Worker(URL.createObjectURL(blob));
        worker.onmessage = function(e) {
          const cb = callbacks.get(e.data.id);
          if (cb) cb();
        };
      } catch (err) {
        console.warn('[NodeLoc v21.7.0] Worker 初始化失败，降级使用原生计时器:', err);
        worker = null;
      }
      return worker;
    }

    return {
      setTimeout(fn, ms) {
        const w = initWorker();
        const id = nextId++;
        callbacks.set(id, () => { callbacks.delete(id); fn(); });
        if (w) { w.postMessage({ type: 'setTimeout', id, interval: ms }); }
        else { return window.setTimeout(fn, ms); }
        return id;
      },
      clearTimeout(id) {
        if (!id) return;
        callbacks.delete(id);
        const w = initWorker();
        if (w) { w.postMessage({ type: 'clear', id }); }
        else { window.clearTimeout(id); }
      }
    };
  })();

  // ============================================================
  // 持久化存储与配置
  // ============================================================
  const STORE = {
    get(k, def) { try { const v = GM_getValue(k); return v === undefined ? def : v; } catch { return def; } },
    set(k, v)  { try { GM_setValue(k, v); } catch {} }
  };

  const RequestLog = {
    KEY: 'nl_ai_request_logs',
    MAX: 10,
    getAll() {
      const savedLogs = STORE.get(this.KEY, []);
      return Array.isArray(savedLogs) ? savedLogs : [];
    },
    create(entry) {
      const nextLogs = [...this.getAll(), entry].slice(-this.MAX);
      STORE.set(this.KEY, nextLogs);
    },
    update(id, result) {
      const nextLogs = this.getAll().map(entry => entry.id === id ? { ...entry, result } : entry);
      STORE.set(this.KEY, nextLogs);
    },
    clear() { STORE.set(this.KEY, []); }
  };

  function copyToClipboard(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text, 'text');
      return Promise.resolve();
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return Promise.resolve();
    }
  }

  const CFG = {
    get mode()              { return STORE.get('nl_mode', 'random'); },
    set mode(v)             { STORE.set('nl_mode', v); },
    get uniformSpeed()      { return STORE.get('nl_uniformSpeed', 2); },
    set uniformSpeed(v)     { STORE.set('nl_uniformSpeed', v); },
    get randomSpeedMin()    { return STORE.get('nl_randMin', 1); },
    set randomSpeedMin(v)   { STORE.set('nl_randMin', v); },
    get randomSpeedMax()    { return STORE.get('nl_randMax', 4); },
    set randomSpeedMax(v)   { STORE.set('nl_randMax', v); },
    get pauseChance()       { return STORE.get('nl_pauseChance', 4); },
    set pauseChance(v)      { STORE.set('nl_pauseChance', v); },
    get autoNext()          { return STORE.get('nl_autoNext', true); },
    set autoNext(v)         { STORE.set('nl_autoNext', v); },
    get panelCollapsed()    { return STORE.get('nl_collapsed', false); },
    set panelCollapsed(v)   { STORE.set('nl_collapsed', v); },
    get activeTab()         { return STORE.get('nl_active_tab', 'roam'); },
    set activeTab(v)        { STORE.set('nl_active_tab', v); },

    get targetDwellTime()   { return STORE.get('nl_target_dwell', 120); },
    set targetDwellTime(v)  { STORE.set('nl_target_dwell', v); },
    get pauseOnHidden()     { return STORE.get('nl_pause_on_hidden', true); },
    set pauseOnHidden(v)    { STORE.set('nl_pause_on_hidden', v); },

    // NodeLoc 用户名配置（用于 upgrade-progress.json 直读）
    get username()          { return STORE.get('nl_username', ''); },
    set username(v)         { STORE.set('nl_username', (v || '').trim()); },

    get apiFormat()         { return STORE.get('nl_api_format', 'openai'); },
    set apiFormat(v)        { STORE.set('nl_api_format', v); },
    get apiUrl()            { return STORE.get('nl_api_url', 'https://modelgate.app'); },
    set apiUrl(v)           { STORE.set('nl_api_url', v); },
    get apiKey()            { return STORE.get('nl_api_key', ''); },
    set apiKey(v)           { STORE.set('nl_api_key', v); },
    get modelName()         { return STORE.get('nl_api_model', 'gpt-4o-mini'); },
    set modelName(v)        { STORE.set('nl_api_model', v); }
  };

  const HistoryManager = {
    MAX: 1000,
    getAll() { return STORE.get('nl_visited_ids', []); },
    add(id) {
      if (!id) return;
      id = String(id);
      let list = this.getAll().filter(x => x !== id);
      list.push(id);
      if (list.length > this.MAX) list = list.slice(list.length - 800);
      STORE.set('nl_visited_ids', list);
      if (panel) panel.updateStats();
    },
    isVisited(id) { return !id ? false : this.getAll().includes(String(id)); },
    clear() {
      STORE.set('nl_visited_ids', []);
      if (panel) { panel.updateStats(); panel.setStatus('已读记录已清空'); }
    },
    count() { return this.getAll().length; }
  };

  // 自动尝试感知当前登录的 NodeLoc 用户名
  function detectCurrentUsername() {
    try {
      if (window.Discourse?.User?.current()?.username) {
        return window.Discourse.User.current().username;
      }
    } catch (e) {}

    const userCardLink = document.querySelector('#current-user a, .current-user a, [data-user-card]');
    if (userCardLink) {
      const dataCard = userCardLink.getAttribute('data-user-card');
      if (dataCard) return dataCard.trim();
      const href = userCardLink.getAttribute('href') || '';
      const m = href.match(/\/u\/([^/]+)/);
      if (m) return m[1].trim();
    }

    const avatar = document.querySelector('#current-user img.avatar, .current-user img.avatar');
    if (avatar) {
      const alt = avatar.getAttribute('alt') || avatar.getAttribute('title');
      if (alt && !alt.includes('avatar')) return alt.trim();
    }
    return '';
  }

  // ============================================================
  // 成长指标模块（全新升级：官方 upgrade-progress.json 直读）
  // ============================================================
  const GrowthMetrics = (() => {
    const state = { data: null, updatedAt: null, loading: false, error: '' };

    const metricMeta = {
      '阅读时长（分钟）': { key: 'readTime', label: '阅读时长', unit: '分钟', icon: '⏱️' },
      '阅读时长': { key: 'readTime', label: '阅读时长', unit: '分钟', icon: '⏱️' },
      'time_read': { key: 'readTime', label: '阅读时长', unit: '分钟', icon: '⏱️' },

      '回复话题': { key: 'repliedTopics', label: '回复话题', unit: '个', icon: '💬' },
      'topic_replied': { key: 'repliedTopics', label: '回复话题', unit: '个', icon: '💬' },
      'topics_replied_to': { key: 'repliedTopics', label: '回复话题', unit: '个', icon: '💬' },

      '进入话题': { key: 'visitedTopics', label: '进入话题', unit: '个', icon: '📖' },
      'topics_entered': { key: 'visitedTopics', label: '进入话题', unit: '个', icon: '📖' },

      '阅读帖子': { key: 'readPosts', label: '阅读帖子', unit: '篇', icon: '👀' },
      'posts_read': { key: 'readPosts', label: '阅读帖子', unit: '篇', icon: '👀' },

      '访问天数': { key: 'activeDays', label: '访问天数', unit: '天', icon: '📅' },
      'days_visited': { key: 'activeDays', label: '访问天数', unit: '天', icon: '📅' },

      '收到的赞': { key: 'receivedLikes', label: '收到的赞', unit: '个', icon: '❤️' },
      'likes_received': { key: 'receivedLikes', label: '收到的赞', unit: '个', icon: '❤️' },

      '送出的赞': { key: 'givenLikes', label: '送出的赞', unit: '个', icon: '👍' },
      'likes_given': { key: 'givenLikes', label: '送出的赞', unit: '个', icon: '👍' }
    };

    function toNumber(value) {
      const matched = String(value ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
      return matched ? Number(matched[0]) : 0;
    }

    // 弹性解析官方 upgrade-progress.json 数据
    function parseUpgradeProgressJson(json) {
      if (!json || typeof json !== 'object') throw new Error('接口返回格式异常');

      const raw = json.upgrade_progress || json.data || json;

      // 提取等级信息
      let currentLevel = raw.current_level || raw.currentLevel || raw.current_trust_level || '当前等级';
      let nextLevel = raw.next_level || raw.nextLevel || raw.target_level || '下一等级';
      if (Array.isArray(raw.levels) && raw.levels.length >= 2) {
        currentLevel = raw.levels[0];
        nextLevel = raw.levels[1];
      }

      // 提取指标项
      const rawMetrics = Array.isArray(raw.metrics) ? raw.metrics
        : Array.isArray(raw.requirements) ? raw.requirements
        : Array.isArray(raw.cards) ? raw.cards
        : Array.isArray(raw.items) ? raw.items
        : (raw.requirements && typeof raw.requirements === 'object') ? Object.values(raw.requirements)
        : [];

      const metrics = rawMetrics.map(item => {
        const rawLabel = String(item.label || item.name || item.title || item.key || item.id || '').trim();
        const meta = metricMeta[rawLabel] || metricMeta[item.key] || {
          key: item.key || rawLabel,
          label: rawLabel || '未知指标',
          unit: item.unit || '',
          icon: '📌'
        };

        const value = toNumber(item.value ?? item.current ?? item.count);
        const target = toNumber(item.target ?? item.required ?? item.max);
        let progress = item.progress !== undefined ? toNumber(item.progress)
          : (target > 0 ? Math.min(100, Math.round((value / target) * 100)) : 100);

        const reached = Boolean(item.reached ?? item.met ?? item.is_met ?? (target > 0 && value >= target));
        return { ...meta, value, target, progress, reached };
      }).filter(m => m.label && m.target > 0);

      // 统计满足情况
      const satisfiedCount = raw.satisfied_count ?? raw.satisfiedCount ?? raw.met_count
        ?? metrics.filter(m => m.reached).length;
      const unmetCount = raw.unmet_count ?? raw.unmetCount ?? raw.unmet
        ?? (metrics.length > 0 ? metrics.filter(m => !m.reached).length : 0);

      let overallPercent = raw.overall_percent ?? raw.overallPercent ?? raw.percentage ?? raw.gauge_value;
      if (overallPercent === undefined || overallPercent === null) {
        overallPercent = metrics.length > 0 ? Math.round((satisfiedCount / metrics.length) * 100) : 0;
      }
      overallPercent = Math.min(100, Math.max(0, toNumber(overallPercent)));

      const accountStatus = raw.account_status || raw.accountStatus || raw.status || '未被禁言或封禁';

      return {
        overallPercent,
        currentLevel,
        nextLevel,
        satisfiedCount,
        unmetCount,
        accountStatus,
        metrics
      };
    }

    async function refresh(targetUsername = null) {
      if (state.loading) return state;

      let username = (targetUsername || CFG.username || detectCurrentUsername()).trim();
      if (!username) {
        state.error = '请先配置 NodeLoc 用户名';
        return state;
      }
      if (!CFG.username && username) {
        CFG.username = username;
      }

      state.loading = true;
      state.error = '';

      try {
        const url = `/u/${encodeURIComponent(username)}/upgrade-progress.json`;
        const res = await fetch(url, {
          credentials: 'same-origin',
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
          }
        });

        if (!res.ok) {
          if (res.status === 404) throw new Error(`未找到账号 [${username}] 的升级进度，请核对用户名`);
          if (res.status === 403) throw new Error(`无权限访问（HTTP 403），请确认是否已在浏览器中登录 NodeLoc`);
          throw new Error(`获取失败: HTTP ${res.status}`);
        }

        const json = await res.json();
        state.data = parseUpgradeProgressJson(json);
        state.updatedAt = new Date();
      } catch (err) {
        state.error = err.message || '成长指标获取异常';
      } finally {
        state.loading = false;
      }
      return state;
    }

    return { getState: () => state, refresh };
  })();

  function isTopicPage() { return /^\/t\/[^/]+\/\d+/.test(window.location.pathname); }
  function getTopicId() {
    const m = window.location.pathname.match(/\/t\/[^/]+\/(\d+)/);
    return m ? String(m[1]) : null;
  }
  function getScrollY() { return window.scrollY || 0; }
  function getMaxScroll() {
    return Math.max(document.documentElement.scrollHeight - window.innerHeight,
                    document.body.scrollHeight - window.innerHeight, 0);
  }
  function isAtBottom() { return getScrollY() >= getMaxScroll() - 150; }

  function navigateSpa(url) {
    try {
      if (window.DiscourseURL && typeof window.DiscourseURL.routeTo === 'function') {
        window.DiscourseURL.routeTo(url);
        return;
      }
    } catch (e) {}

    const link = document.createElement('a');
    link.href = url;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => link.remove(), 200);

    const oldPath = window.location.pathname;
    WorkerTimer.setTimeout(() => {
      if (window.location.pathname === oldPath && window.location.href !== url) {
        window.location.href = url;
      }
    }, 1500);
  }

  // ============================================================
  // 回复筛选管道（融合 shuorenhua 去 AI 味核心体系）
  // ============================================================
  const ReplyPipeline = {
    BANNED_PATTERNS: [
      /感谢.{0,4}(?:分享|楼主|大[神佬]|整理)/i, /干货满满/i, /受益匪浅/i, /值得收藏/i,
      /写得?(?:太好了|真棒|真详细|很好)/i, /很有参考价值/i, /总结.{0,4}到位/i,
      /思路清晰/i, /深入浅出/i, /很有深度/i, /字字珠玑/i, /先赞后看|码住|马克/i,
      /受教了/i, /楼主好人/i,
      /作为\s*(?:ai|人工智能|语言模型|助手)/i, /希望(?:能)?对你有?所?帮助/i,
      /如果有?(?:任何)?疑问/i, /欢迎(?:在下方)?(?:交流|讨论|留言)/i,
      /随时(?:问我|交流)/i, /为你解答/i, /很高兴为您/i,
      /与其说.{1,10}不如说/i, /不是.{1,10}而是/i, /如果我告诉你/i, /你心动了吗/i,
      /让我们?拭目以待/i, /开启.{0,4}新篇章/i, /迈向新台阶/i, /里程碑/i,
      /未来可期/i, /共同见证/i, /全新跃迁/i, /稳稳接住/i,
      /赋能/i, /闭环/i, /抓手/i, /打通底层逻辑/i, /组合拳/i, /系统性重塑/i,
      /降本增效/i, /多维度/i, /全方位/i, /价值链/i,
      /总的来说/i, /综上所述/i, /不得不说/i, /不可否认/i, /显而易见/i,
      /值得一提的是/i, /毋庸置疑/i, /正如前文所述/i, /毫无疑问/i,
      /(?:大家|你)(?:觉得呢|怎么看)[？?]?$/i
    ],

    AGGRESSIVE_PATTERNS: [
      /傻[子逼瓜]?/i, /蠢/i, /垃圾/i, /废物/i, /智商/i,
      /笑死/i, /活该/i, /割韭菜/i, /脑残/i, /骗[子钱]?/i
    ],

    detectScene(title, mainContent) {
      const text = `${title} ${mainContent}`.toLowerCase();
      if (/抽奖|口令|红包|福袋|抽券|能量|盖楼|散财|福利|庆祝/i.test(text)) {
        return { id: 'lottery', label: '抽奖福利', icon: '🎁' };
      }
      if (/测速|测评|跑分|评测|路由|回程|晚高峰|丢包|延迟|网络|三网|4837|9929|cmin2|gia|节点|搭建|docker/i.test(text)) {
        return { id: 'tech_benchmark', label: '测速技术', icon: '⚡' };
      }
      if (/出|收|盘|溢价|剩余价值|改邮箱|push|续费|出台|出个|明盘|自提|吃灰/i.test(text)) {
        return { id: 'trade', label: '集市交易', icon: '💰' };
      }
      if (/求助|报错|无法连接|超时|救砖|失联|封ip|怎么解决|求教|请问|求解|请教/i.test(text)) {
        return { id: 'troubleshoot', label: '排障求助', icon: '🛠️' };
      }
      return { id: 'general', label: '日常杂谈', icon: '💬' };
    },

    getVisibleLength(text) {
      return Array.from(String(text || '')).filter(char => !/\s/.test(char)).length;
    },

    selectMainFacts(mainContent, title) {
      const rawSentences = String(mainContent || '')
        .split(/[。！？；\r\n]+/)
        .map(s => s.trim())
        .filter(s => this.getVisibleLength(s) >= 6);

      const titleTerms = String(title || '').match(/[a-z0-9\u4e00-\u9fa5]{2,}/ig) || [];
      const factPattern = /\d|ip|vps|cpu|内存|流量|带宽|延迟|套餐|配置|测速|价格|费用|开卡|注册|升级|等级|时长|积分|规则|机制|抽奖|能量|券|挂起|门控|教程|实测|搬瓦工|斯巴达|甲骨文|瓦工|cc|rn|dmit|hetzner|ovh|ping/i;
      const keySectionPattern = /费用|条件|步骤|规则|总结|结论|实测|注意|建议|阈值|限制|方法|踩坑|口令|要求|线路|机房/i;

      return rawSentences.map((sentence, index) => ({
        sentence,
        index,
        score: (factPattern.test(sentence) ? 2 : 0)
          + (keySectionPattern.test(sentence) ? 3 : 0)
          + (titleTerms.some(term => term.length >= 2 && sentence.includes(term)) ? 3 : 0)
      }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map(item => item.sentence)
        .filter((sentence, idx, arr) => arr.indexOf(sentence) === idx)
        .slice(0, 6);
    },

    cleanCandidate(raw) {
      return String(raw || '')
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
        .replace(/^\s*(?:[-*]|(?:候选\s*)?\d+[.、):：])\s*/, '')
        .replace(/[。！!？?]+$/, '')
        .trim();
    },

    isCandidateValid(candidate) {
      const isBanned = this.BANNED_PATTERNS.some(p => p.test(candidate));
      const isAggressive = this.AGGRESSIVE_PATTERNS.some(p => p.test(candidate));
      const len = this.getVisibleLength(candidate);
      return !isBanned && !isAggressive && len >= 6 && len <= 45;
    },

    validateCandidates(candidates) {
      const validCandidates = [];
      const candidateChecks = [];

      for (const rawCandidate of candidates || []) {
        const candidate = this.cleanCandidate(rawCandidate);
        const isValid = this.isCandidateValid(candidate) && !validCandidates.includes(candidate);
        candidateChecks.push({ candidate, isValid });
        if (isValid) validCandidates.push(candidate);
      }

      return {
        shouldReply: validCandidates.length > 0,
        validCandidates,
        candidateChecks
      };
    },

    getCandidateText(item) {
      if (typeof item === 'string') return item.trim();
      if (!item || typeof item !== 'object') return '';
      const possible = item.text || item.reply || item.candidate || item.response || item.content
        || (item.message && item.message.content);
      if (typeof possible === 'string') return possible.trim();
      if (possible && typeof possible === 'object') return this.getCandidateText(possible);
      return '';
    },

    getCandidateItems(payload) {
      if (Array.isArray(payload)) return payload;
      if (!payload || typeof payload !== 'object') return [];
      const items = payload.candidates || payload.replies || payload.responses || payload.choices
        || payload.items || payload.results || payload.reply || payload.response || payload.answer;
      if (items !== undefined) return Array.isArray(items) ? items : [items];
      if (payload.data) return this.getCandidateItems(payload.data);
      return [];
    },

    extractJsonPayload(text) {
      const startIndex = text.search(/[\[{]/);
      if (startIndex === -1) return '';
      const openingChar = text[startIndex];
      const closingChar = openingChar === '{' ? '}' : ']';
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = startIndex; i < text.length; i++) {
        const char = text[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') { inString = true; }
        else if (char === openingChar) { depth++; }
        else if (char === closingChar) {
          depth--;
          if (depth === 0) return text.slice(startIndex, i + 1);
        }
      }
      return '';
    },

    extractLineCandidates(text) {
      return String(text || '')
        .replace(/```(?:json)?/gi, '')
        .split(/\r?\n/)
        .map(line => this.cleanCandidate(line))
        .filter(line => line.length >= 6 && !/[\[{]/.test(line))
        .slice(0, 3);
    },

    parseModelResponse(text) {
      const normalized = String(text || '')
        .trim()
        .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '');

      const jsonPayload = this.extractJsonPayload(normalized);
      let candidates = [];
      let parseMode = 'line_fallback';
      if (jsonPayload) {
        try {
          const parsed = JSON.parse(jsonPayload);
          candidates = this.getCandidateItems(parsed)
            .map(item => this.cleanCandidate(this.getCandidateText(item)))
            .filter(Boolean)
            .slice(0, 3);
          parseMode = 'json';
        } catch (err) {}
      }
      if (candidates.length === 0) {
        candidates = this.extractLineCandidates(normalized);
        if (candidates.length > 0) parseMode = 'line_fallback';
      }
      return { candidates, parseMode };
    }
  };

  // ============================================================
  // AI 回复生成引擎
  // ============================================================
  const AIReplyEngine = {
    getPostTextFromHtml(cookedHtml, removeQuotes = true) {
      const doc = new DOMParser().parseFromString(String(cookedHtml || ''), 'text/html');
      if (removeQuotes) {
        doc.querySelectorAll('blockquote, .quote, .quote-title').forEach(node => node.remove());
      }
      return doc.body.textContent.replace(/\s+/g, ' ').trim();
    },

    getLoadedPosts() {
      const postElements = Array.from(document.querySelectorAll('.topic-post, article[data-post-number]'));
      const seen = new Set();
      return postElements.map((el, idx) => {
        const num = el.getAttribute('data-post-number') || String(idx + 1);
        if (seen.has(num)) return null;
        seen.add(num);
        const contentEl = el.querySelector('.cooked');
        if (!contentEl) return null;
        const userEl = el.querySelector('.names .username, .username, [data-user-card]');
        const clone = contentEl.cloneNode(true);
        if (Number(num) !== 1) {
          clone.querySelectorAll('blockquote, .quote, .quote-title').forEach(node => node.remove());
        }
        return {
          postNumber: Number(num),
          username: userEl ? userEl.innerText.trim() : `楼友${num}`,
          text: clone.innerText.replace(/\s+/g, ' ').trim()
        };
      }).filter(Boolean);
    },

    async getTopicPostsFromApi() {
      const topicId = getTopicId();
      if (!topicId) return [];
      try {
        const res = await fetch(`/t/${topicId}.json`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const apiPosts = data && data.post_stream && Array.isArray(data.post_stream.posts)
          ? data.post_stream.posts : [];
        return apiPosts.map(post => ({
          postNumber: Number(post.post_number),
          username: String(post.username || post.name || `楼友${post.post_number}`),
          text: this.getPostTextFromHtml(post.cooked, Number(post.post_number) !== 1)
        })).filter(post => post.postNumber > 0 && post.text);
      } catch (err) {
        return [];
      }
    },

    async getTopicFullContext() {
      const titleEl = document.querySelector('#topic-title h1 a, #topic-title h1, .title-wrapper h1');
      const title = titleEl ? titleEl.innerText.trim() : document.title;
      const firstPost = document.querySelector(
        'article[data-post-number="1"] .cooked, [data-post-number="1"] .cooked, .topic-post:first-child .cooked, #post_1 .cooked, .post-stream .cooked'
      );
      let mainContent = '';
      const imageDescriptions = [];

      if (firstPost) {
        const contentClone = firstPost.cloneNode(true);
        mainContent = contentClone.innerText.replace(/\s+/g, ' ').trim();
        if (mainContent.length > 900) mainContent = mainContent.slice(0, 900) + '...';

        const imageNodes = Array.from(firstPost.querySelectorAll('a.lightbox, img:not(.avatar):not(.emoji), .lightbox'))
          .filter(node => node.tagName === 'A' || !node.closest('a.lightbox'));
        const seenUrls = new Set();
        imageNodes.forEach((node, idx) => {
          if (seenUrls.size >= 3) return;
          const alt = node.getAttribute('alt') || node.getAttribute('title') || '';
          const src = node.getAttribute('href') || node.getAttribute('src') || '';
          if (!src || src.includes('/emoji/')) return;
          try {
            const fullUrl = new URL(src, window.location.href).href;
            if (!seenUrls.has(fullUrl)) {
              seenUrls.add(fullUrl);
              imageDescriptions.push(`[图片${idx + 1}${alt ? ': ' + alt : ''}]`);
            }
          } catch (err) {}
        });
      }

      const loadedPosts = this.getLoadedPosts();
      const apiPosts = await this.getTopicPostsFromApi();
      const postMap = new Map();
      apiPosts.forEach(p => postMap.set(p.postNumber, p));
      loadedPosts.forEach(p => postMap.set(p.postNumber, p));
      const posts = Array.from(postMap.values()).sort((a, b) => a.postNumber - b.postNumber);

      const apiMainPost = posts.find(p => p.postNumber === 1);
      if (apiMainPost && apiMainPost.text) {
        mainContent = apiMainPost.text.slice(0, 900);
      }

      const rawReplies = posts.filter(p => p.postNumber > 1 && p.text);
      const recentReplies = rawReplies.slice(-10);
      const allReplies = recentReplies.map(p => `【${p.postNumber}楼 @${p.username}】：${p.text.slice(0, 120)}`);

      const scene = ReplyPipeline.detectScene(title, mainContent);
      const mainFacts = ReplyPipeline.selectMainFacts(mainContent, title);
      const sourceText = [title, mainContent, ...allReplies].filter(Boolean).join('\n');

      return {
        title,
        mainContent,
        mainFacts,
        allReplies,
        scene,
        imageInfo: imageDescriptions.length > 0 ? imageDescriptions.join('、') : '无图片',
        sourceText
      };
    },

    async generateReply() {
      if (!CFG.apiKey || !CFG.apiUrl) {
        throw new Error('请在「⚙️ 设置」中填入 API Key 和 Base URL');
      }

      const ctx = await this.getTopicFullContext();

      let sceneInstruction = '';
      if (ctx.scene.id === 'lottery') {
        sceneInstruction = `\n【当前场景：抽奖福利】必须严格提取主楼或楼下的指定口令格式；若无口令，只需一句真诚自然的随手祝福或参与（如“支持大佬，当个分母”、“碰碰运气看能不能中”），绝对不要长篇大论或高谈阔论。`;
      } else if (ctx.scene.id === 'tech_benchmark') {
        sceneInstruction = `\n【当前场景：测速技术/配置测评】围绕线路稳定性、延迟、晚高峰、丢包或套餐性价比简明点评或提问（如“这晚高峰回程看着挺稳”、“哪个机房的，看着性价比还行”），保持技术真实感，严禁空洞夸赞。`;
      } else if (ctx.scene.id === 'trade') {
        sceneInstruction = `\n【当前场景：集市交易/收出机器】针对价格、剩余价值、续费成本、push费用或配置简短接话（如“这价位还可以，祝早出”、“续费多少一年，绑定邮箱出吗”），客观直接。`;
      } else if (ctx.scene.id === 'troubleshoot') {
        sceneInstruction = `\n【当前场景：排障求助】直接点出可能的排查方向或原因（如“先看看安全组端口放行没”、“可能是DNS解析慢，改个公共DNS试试”），不讲安慰套话。`;
      } else {
        sceneInstruction = `\n【当前场景：日常杂谈】像论坛常驻老友随手接话，语气随和接地气，就事论事或轻度调侃。`;
      }

      const systemPrompt = `你是在 NodeLoc / Linux.do 论坛活跃的技术爱好者，正在用手机随手浏览帖子并准备回帖。
你的目标是基于主楼事实和最新讨论，输出 3 条不同角度、自然实在、不装腔作势的口语化候选回复。${sceneInstruction}

【说人话（shuorenhua）核心规范与红线】：
1. 优先保事实，绝不编造基数、配置或结果，保留技术术语与主楼核心数据。
2. 严禁一切模板套话与伪客套：绝不允许出现“感谢分享、干货满满、受益匪浅、值得收藏、写得很好、思路清晰、字字珠玑”等。
3. 严禁结构反模式：
   - 禁二元假对比（“不是……而是……”、“比起……更……”）。
   - 禁假升华与宏大愿景（“拭目以待”、“开启新篇章”、“迈向新台阶”、“里程碑”）。
   - 禁机械过渡与总结式收尾（“总的来说”、“综上所述”、“不得不说”、“不可否认”）。
   - 禁客服腔与末尾反问（“希望对你有帮助”、“你怎么看呢”、“欢迎讨论”）。
4. 长度控制在 8 到 30 个字之间，口语自然，末尾严禁加句号（就像手机真人在论坛随手敲字）。

【输出格式要求】：
必须仅输出一个合法 JSON 对象（严禁任何 Markdown 代码块或多余解释）：
{"candidates":["候选1","候选2","候选3"]}`;

      const userPrompt = `【帖子标题】：${ctx.title}
【主楼核心事实】：
${ctx.mainFacts.join('\n') || ctx.mainContent || '（无可用正文）'}
【主楼附带图片】：${ctx.imageInfo}
【楼下最新讨论】：
${ctx.allReplies.join('\n') || '（暂无其他回复，你是前排）'}

请按说人话规范，输出 3 条自然口语化、符合 NodeLoc 氛围的候选回复 JSON：`;

      let url = CFG.apiUrl.trim().replace(/\/+$/, '');
      const isAnthropic = CFG.apiFormat === 'anthropic';

      const requestLogId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      RequestLog.create({
        id: requestLogId,
        createdAt: new Date().toLocaleString('zh-CN', { hour12: false }),
        request: {
          systemPrompt,
          userPrompt,
          model: CFG.modelName,
          format: CFG.apiFormat,
          title: ctx.title,
          scene: ctx.scene.label
        },
        result: { status: 'pending' }
      });

      return new Promise((resolve, reject) => {
        let requestUrl = '';
        let headers = {};
        let bodyData = {};

        if (isAnthropic) {
          requestUrl = url.endsWith('/v1') ? `${url}/messages` : `${url}/v1/messages`;
          headers = {
            'Content-Type': 'application/json',
            'x-api-key': CFG.apiKey,
            'Authorization': `Bearer ${CFG.apiKey}`,
            'anthropic-version': '2023-06-01'
          };
          bodyData = {
            model: CFG.modelName || 'claude-opus-4-8',
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
            max_tokens: 300,
            temperature: 0.75
          };
        } else {
          requestUrl = url.endsWith('/v1') ? `${url}/chat/completions` : `${url}/v1/chat/completions`;
          headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CFG.apiKey}`
          };
          bodyData = {
            model: CFG.modelName || 'gpt-4o-mini',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            temperature: 0.75,
            max_tokens: 300,
            response_format: { type: 'json_object' }
          };
        }

        GM_xmlhttpRequest({
          method: 'POST',
          url: requestUrl,
          headers: headers,
          data: JSON.stringify(bodyData),
          timeout: 20000,
          onload: function (res) {
            let modelReply = '';
            try {
              if (res.status >= 200 && res.status < 300) {
                const json = JSON.parse(res.responseText);
                let reply = '';
                if (json.content && Array.isArray(json.content) && json.content[0]) {
                  reply = json.content[0].text;
                } else if (json.choices && json.choices[0] && json.choices[0].message) {
                  reply = json.choices[0].message.content;
                }
                modelReply = reply || '';

                const payload = ReplyPipeline.parseModelResponse(modelReply);
                const validation = ReplyPipeline.validateCandidates(payload.candidates);

                RequestLog.update(requestLogId, {
                  status: 'success',
                  scene: ctx.scene.label,
                  rawReply: modelReply,
                  parseMode: payload.parseMode,
                  rawCandidates: payload.candidates,
                  validCandidates: validation.validCandidates,
                  candidateChecks: validation.candidateChecks,
                  shouldReply: validation.shouldReply
                });

                resolve({
                  parseMode: payload.parseMode,
                  scene: ctx.scene,
                  rawCandidates: payload.candidates,
                  candidateChecks: validation.candidateChecks,
                  validCandidates: validation.validCandidates,
                  shouldReply: validation.shouldReply,
                  sourceText: ctx.sourceText
                });
              } else {
                const apiError = `API 报错 ${res.status}: ${res.responseText.slice(0, 300)}`;
                RequestLog.update(requestLogId, { status: 'http_error', error: apiError });
                reject(new Error(apiError));
              }
            } catch (err) {
              RequestLog.update(requestLogId, { status: 'parse_error', error: err.message, rawReply: modelReply });
              reject(err);
            }
          },
          onerror: function () {
            RequestLog.update(requestLogId, { status: 'network_error', error: '网络请求异常或被拦截' });
            reject(new Error('网络请求异常或被拦截'));
          },
          ontimeout: function () {
            RequestLog.update(requestLogId, { status: 'timeout', error: '大模型请求超时（20s）' });
            reject(new Error('大模型请求超时，请检查网络或更换模型'));
          }
        });
      });
    },

    async submitReply(text) {
      const topicId = getTopicId();
      if (!topicId) throw new Error('当前未在文章页面');

      const csrfMeta = document.querySelector('meta[name="csrf-token"]');
      if (!csrfMeta || !csrfMeta.content) throw new Error('未检测到登录 Token，请先登录');

      await new Promise(r => setTimeout(r, Math.round(1200 + Math.random() * 800)));

      const res = await fetch('/posts.json', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfMeta.content,
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: JSON.stringify({
          topic_id: topicId,
          raw: text,
          nested_post: true
        })
      });

      if (res.ok) {
        return { ok: true };
      } else {
        const errJson = await res.json().catch(() => ({}));
        const msg = errJson.errors ? errJson.errors.join(', ') : `HTTP ${res.status}`;
        throw new Error(msg);
      }
    }
  };

  // ============================================================
  // 分段拟真引擎
  // ============================================================
  const HumanEngine = {
    _readingPauseUntil: 0,
    getScrollAction() {
      const now = Date.now();
      if (now < this._readingPauseUntil) return 0;
      if (Math.random() * 100 < CFG.pauseChance) {
        this._readingPauseUntil = now + 5000 + Math.random() * 10000;
        return 0;
      }
      const lo = CFG.randomSpeedMin, hi = CFG.randomSpeedMax;
      return Math.max(1, Math.round(lo + Math.pow(Math.random(), 1.5) * (hi - lo)));
    }
  };

  async function getNextTopicUrl() {
    const currentId = getTopicId();
    const suggestedSelectors = [
      '.more-topics__list .title a[href*="/t/"]',
      '.suggested-topics .title a[href*="/t/"]',
      '.topic-list .topic-list-item a.title[href*="/t/"]',
      '.topic-list .main-link a[href*="/t/"]',
      '.sidebar-section-link[href*="/t/"]'
    ];

    const domCandidates = [];
    const seenIds = new Set();
    for (const sel of suggestedSelectors) {
      for (const a of document.querySelectorAll(sel)) {
        const m = a.href.match(/\/t\/[^/]+\/(\d+)/);
        if (m) {
          const id = String(m[1]);
          if (id !== currentId && !seenIds.has(id)) {
            seenIds.add(id);
            domCandidates.push({ id, url: a.href });
          }
        }
      }
    }

    const unvisitedDom = domCandidates.filter(item => !HistoryManager.isVisited(item.id));
    if (unvisitedDom.length > 0) {
      return unvisitedDom[Math.floor(Math.random() * unvisitedDom.length)].url;
    }

    try {
      const res = await fetch('/latest.json');
      if (res.ok) {
        const data = await res.json();
        if (data.topic_list && Array.isArray(data.topic_list.topics)) {
          const apiTopics = data.topic_list.topics
            .filter(t => String(t.id) !== currentId)
            .map(t => ({ id: String(t.id), url: `${window.location.origin}/t/${t.slug || 'topic'}/${t.id}` }));
          const unvisitedApi = apiTopics.filter(t => !HistoryManager.isVisited(t.id));
          if (unvisitedApi.length > 0) {
            return unvisitedApi[Math.floor(Math.random() * unvisitedApi.length)].url;
          }
        }
      }
    } catch (e) {}

    const allHist = HistoryManager.getAll();
    if (allHist.length > 300) STORE.set('nl_visited_ids', allHist.slice(allHist.length - 200));
    else HistoryManager.clear();

    if (domCandidates.length > 0) return domCandidates[Math.floor(Math.random() * domCandidates.length)].url;
    return window.location.origin + '/latest';
  }

  // ============================================================
  // AutoScroller 核心控制器
  // ============================================================
  class AutoScroller {
    constructor() {
      this.active = false;
      this.paused = false;
      this.pausedByHidden = false;
      this._timerId = null;
      this._topicStartTime = 0;
      this._tickCount = 0;
    }

    start() {
      if (this.active) return;
      this.active = true;
      this.paused = false;
      this.pausedByHidden = false;
      this._topicStartTime = Date.now();
      HumanEngine._readingPauseUntil = 0;

      const curId = getTopicId();
      if (curId) HistoryManager.add(curId);

      this._schedule();
    }

    stop() {
      this.active = false;
      this._clearTimers();
    }

    togglePause() {
      if (!this.active) { this.start(); return; }
      this.paused = !this.paused;
      this.pausedByHidden = false;
    }

    onVisibilityChange() {
      if (!CFG.pauseOnHidden || !this.active) return;
      if (document.hidden) {
        if (!this.paused) {
          this.pausedByHidden = true;
          panel.setActivityStatus('⚠️ 标签页已切走/最小化，自动挂起');
          panel.updatePauseBtn();
        }
      } else {
        if (this.pausedByHidden) {
          this.pausedByHidden = false;
          panel.setActivityStatus('✅ 已切回可见标签，继续漫游计时...');
          panel.updatePauseBtn();
        }
      }
    }

    _clearTimers() {
      if (this._timerId) { WorkerTimer.clearTimeout(this._timerId); this._timerId = null; }
    }

    _schedule() {
      const interval = CFG.mode === 'uniform' ? 30 : Math.round(28 + Math.random() * 45);
      this._timerId = WorkerTimer.setTimeout(() => {
        if (!this.active) return;
        this._tick();
        if (this.active) this._schedule();
      }, interval);
    }

    _tick() {
      if (!this.active || this.paused || this.pausedByHidden) return;
      this._tickCount++;

      const dwellElapsed = Math.floor((Date.now() - this._topicStartTime) / 1000);
      const targetDwell = Math.max(30, CFG.targetDwellTime);
      const estimatedTimings = Math.floor(dwellElapsed / 60);
      const pct = Math.min(100, Math.round(getScrollY() / Math.max(getMaxScroll(), 1) * 100));

      if (this._tickCount % 4 === 0) {
        panel.updateLiveMetrics(pct, dwellElapsed, targetDwell, estimatedTimings);
      }

      // 6 分钟封顶强切
      const HARD_CAP_SECONDS = 360;
      if (dwellElapsed >= HARD_CAP_SECONDS) {
        this.stop();
        panel.setStatus('⏱️ 本帖已达 6 分钟（360s）时长上限，自动切帖...');
        WorkerTimer.setTimeout(() => this._navigateNext(), 1200);
        return;
      }

      if (isAtBottom()) {
        if (dwellElapsed < targetDwell) {
          if (this._tickCount % 20 === 0) {
            panel.setActivityStatus(`📖 已读完(底)，驻留吃时长: ${dwellElapsed}s/${targetDwell}s (上报~${estimatedTimings}次)`);
            if (Math.random() < 0.2) window.scrollBy(0, Math.random() > 0.5 ? -12 : 12);
          }
          return;
        }

        this.stop();
        panel.setStatus(`🎉 已足额停留 ${dwellElapsed}s 并已触底，切帖中...`);
        WorkerTimer.setTimeout(() => this._navigateNext(), 1500);
        return;
      }

      let px = CFG.mode === 'uniform' ? CFG.uniformSpeed : HumanEngine.getScrollAction();
      if (px > 0) window.scrollBy(0, px);

      if (this._tickCount % 25 === 0) {
        const statusText = px === 0
          ? `🧐 驻留精读中 ${pct}% | ${dwellElapsed}s/${targetDwell}s`
          : `🎲 漫游阅读 ${pct}% | ${dwellElapsed}s/${targetDwell}s`;
        panel.setActivityStatus(statusText);
      }
    }

    async _navigateNext() {
      if (!CFG.autoNext) {
        this.stop();
        panel.setStatus('本帖阅读完成（未开启自动切帖）');
        return;
      }
      panel.setStatus('正在挑选下一篇...');
      const url = await getNextTopicUrl();
      if (url) {
        panel.setStatus('正在平滑跳转...');
        navigateSpa(url);
      } else {
        this.stop();
        panel.setStatus('暂无更多文章');
      }
    }
  }

  // ============================================================
  // 悬浮控制面板 UI
  // ============================================================
  const panel = (() => {
    let el, statusEl, statsEl, replyTextarea, candidateList, sendBtn, logBox, sceneBadge;
    let progressBarFill, dwellBarFill, miniCapsuleEl, cardEl, replyCharCounter;
    let collapsed = CFG.panelCollapsed;
    let replyStatusPinned = false;

    const css = `
      :root {
        --nl-bg: rgba(255, 255, 255, 0.98);
        --nl-border: rgba(0, 0, 0, 0.08);
        --nl-shadow: 0 16px 42px rgba(10, 25, 50, 0.14);
        --nl-text: #1e293b;
        --nl-text-muted: #64748b;
        --nl-surface: #f8fafc;
        --nl-surface-hover: #f1f5f9;
        --nl-surface-border: #e2e8f0;
        --nl-primary: #0a7cff;
        --nl-primary-hover: #0066dc;
        --nl-primary-light: #eaf3ff;
        --nl-accent: #f59e0b;
        --nl-success: #10b981;
        --nl-danger: #ef4444;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --nl-bg: rgba(26, 28, 35, 0.98);
          --nl-border: rgba(255, 255, 255, 0.1);
          --nl-shadow: 0 18px 48px rgba(0, 0, 0, 0.65);
          --nl-text: #f8fafc;
          --nl-text-muted: #94a3b8;
          --nl-surface: #1e212b;
          --nl-surface-hover: #292d3a;
          --nl-surface-border: #333848;
          --nl-primary: #3b82f6;
          --nl-primary-hover: #2563eb;
          --nl-primary-light: rgba(59, 130, 246, 0.16);
        }
      }

      #nl-panel {
        position: fixed; right: 20px; bottom: 24px; z-index: 2147483647;
        font: 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif;
        color: var(--nl-text); user-select: none;
      }
      #nl-panel * { box-sizing: border-box; }

      /* 超轻量全功能胶囊态 */
      #nl-mini-capsule {
        display: none; align-items: center; gap: 6px;
        background: var(--nl-bg); border: 1px solid var(--nl-border);
        border-radius: 30px; padding: 5px 10px; box-shadow: var(--nl-shadow);
        cursor: move; backdrop-filter: blur(14px); font-size: 11px; white-space: nowrap;
        user-select: none; transition: box-shadow 0.2s ease;
      }
      #nl-mini-capsule:hover { box-shadow: 0 8px 24px rgba(10,124,255,0.28); }
      #nl-panel.is-collapsed #nl-mini-capsule { display: flex; }
      #nl-panel.is-collapsed #nl-card { display: none; }

      .nl-pulse-dot {
        width: 8px; height: 8px; border-radius: 50%; background: var(--nl-success);
        box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.6); animation: nl-pulse 2s infinite; flex-shrink: 0;
      }
      .nl-pulse-dot.paused { background: var(--nl-accent); animation: none; }
      @keyframes nl-pulse {
        0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
        70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
        100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
      }

      .nl-capsule-btn {
        background: var(--nl-surface-border); border: none; border-radius: 12px;
        padding: 2px 7px; font-size: 10px; font-weight: 700; color: var(--nl-text); cursor: pointer;
        display: inline-flex; align-items: center; gap: 2px; line-height: 1.3; flex-shrink: 0;
        transition: 0.15s;
      }
      .nl-capsule-btn:hover { background: var(--nl-primary); color: #fff; }
      .nl-capsule-btn.growth { background: rgba(245, 158, 11, 0.15); color: #d97706; }
      .nl-capsule-btn.growth:hover { background: var(--nl-accent); color: #fff; }

      #nl-card {
        background: var(--nl-bg); border: 1px solid var(--nl-border);
        border-radius: 16px; box-shadow: var(--nl-shadow);
        width: 338px; overflow: hidden; backdrop-filter: blur(18px);
        display: flex; flex-direction: column;
      }

      #nl-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 9px 12px; background: linear-gradient(135deg, #0a7cff 0%, #0056d6 100%);
        color: #fff; cursor: move;
      }
      #nl-header-title { font-weight: 700; font-size: 12.5px; display: flex; align-items: center; gap: 6px; }
      #nl-badge {
        background: rgba(255,255,255,0.22); font-size: 9.5px; padding: 1px 6px;
        border-radius: 12px; font-weight: normal;
      }
      .nl-icon-btn {
        background: none; border: none; color: #fff; cursor: pointer;
        font-size: 14px; padding: 2px 6px; border-radius: 5px; opacity: 0.85;
      }
      .nl-icon-btn:hover { opacity: 1; background: rgba(255,255,255,0.22); }

      #nl-pinned-bar {
        padding: 8px 12px 6px; background: var(--nl-surface);
        border-bottom: 1px solid var(--nl-surface-border); display: flex; flex-direction: column; gap: 5px;
      }
      #nl-status {
        font-size: 11px; font-weight: 500; color: var(--nl-text);
        display: flex; align-items: center; min-height: 18px; word-break: break-all;
      }

      .nl-dual-progress { display: flex; flex-direction: column; gap: 4px; }
      .nl-track-row { display: flex; align-items: center; gap: 8px; }
      .nl-track-label { font-size: 10px; color: var(--nl-text-muted); flex: 0 0 26px; white-space: nowrap; }
      .nl-track-bg { flex: 1; height: 5px; background: var(--nl-surface-border); border-radius: 3px; overflow: hidden; }
      .nl-track-fill { height: 100%; width: 0%; border-radius: 3px; transition: width 0.3s ease; }
      .nl-track-fill.scroll { background: linear-gradient(90deg, #0a7cff, #38bdf8); }
      .nl-track-fill.dwell { background: linear-gradient(90deg, #10b981, #f59e0b); }
      .nl-track-val {
        font-size: 10px; font-weight: 600; color: var(--nl-text-muted);
        flex: 0 0 65px; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap;
      }

      .nl-quick-actions { display: flex; gap: 6px; margin-top: 2px; }
      .nl-btn-quick {
        flex: 1; padding: 5px 0; border-radius: 8px; border: none; font-size: 11px; font-weight: 600;
        cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px; transition: 0.15s;
      }
      .nl-btn-quick.primary { background: var(--nl-primary); color: #fff; }
      .nl-btn-quick.primary:hover { background: var(--nl-primary-hover); }
      .nl-btn-quick.secondary { background: var(--nl-surface-border); color: var(--nl-text); }
      .nl-btn-quick.secondary:hover { background: var(--nl-surface-hover); }

      #nl-tabs {
        display: flex; background: var(--nl-surface); padding: 4px 6px;
        border-bottom: 1px solid var(--nl-surface-border); gap: 4px;
      }
      .nl-tab-btn {
        flex: 1 1 0; min-width: 0; height: 30px; padding: 0 2px; border: none; background: none;
        border-radius: 6px; font-size: 11px; font-weight: 600; color: var(--nl-text-muted); cursor: pointer;
        display: flex; align-items: center; justify-content: center; gap: 3px; white-space: nowrap;
      }
      .nl-tab-btn.active {
        background: var(--nl-bg); color: var(--nl-primary); box-shadow: 0 1px 3px rgba(0,0,0,0.06);
      }
      .nl-tab-badge {
        font-size: 9px; padding: 1px 4px; border-radius: 5px; background: var(--nl-primary-light);
        color: var(--nl-primary); font-weight: 700; line-height: 1.1; white-space: nowrap; flex-shrink: 0;
      }

      #nl-body {
        padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px;
        max-height: 480px; overflow-y: auto;
      }
      .nl-tab-content { display: none; flex-direction: column; gap: 8px; }
      .nl-tab-content.active { display: flex; }

      .nl-row { display: flex; align-items: center; justify-content: space-between; font-size: 11px; }
      .nl-row-label { color: var(--nl-text-muted); font-size: 11px; }
      .nl-input-group { display: flex; flex-direction: column; gap: 3px; }
      .nl-input-group label { font-size: 10px; color: var(--nl-text-muted); }
      .nl-input {
        height: 30px; padding: 0 8px; border: 1px solid var(--nl-surface-border); border-radius: 6px;
        font-size: 11px; outline: none; background: var(--nl-bg); color: var(--nl-text);
      }
      .nl-input:focus { border-color: var(--nl-primary); box-shadow: 0 0 0 2px var(--nl-primary-light); }

      .nl-slider-row { display: flex; align-items: center; gap: 8px; font-size: 11px; }
      .nl-slider-row label { flex: 0 0 70px; color: var(--nl-text-muted); }
      .nl-slider-row input[type=range] { flex: 1; cursor: pointer; accent-color: var(--nl-primary); }
      .nl-slider-val { flex: 0 0 36px; text-align: right; font-weight: 700; color: var(--nl-primary); }

      .nl-toggle { position: relative; width: 34px; height: 18px; display: inline-block; cursor: pointer; }
      .nl-toggle input { opacity: 0; width: 0; height: 0; }
      .nl-track { position: absolute; inset: 0; background: var(--nl-surface-border); border-radius: 20px; transition: 0.2s; }
      .nl-track::after {
        content: ''; position: absolute; left: 2px; top: 2px; width: 14px; height: 14px;
        background: #fff; border-radius: 50%; transition: 0.2s;
      }
      .nl-toggle input:checked + .nl-track { background: var(--nl-primary); }
      .nl-toggle input:checked + .nl-track::after { transform: translateX(16px); }

      .nl-pill-group { display: flex; gap: 5px; background: var(--nl-surface); padding: 3px; border-radius: 8px; }
      .nl-pill-btn {
        flex: 1; padding: 4px 0; border: none; border-radius: 6px; background: none;
        color: var(--nl-text-muted); font-size: 11px; font-weight: 600; cursor: pointer; transition: 0.15s;
      }
      .nl-pill-btn.active { background: var(--nl-bg); color: var(--nl-primary); box-shadow: 0 1px 3px rgba(0,0,0,0.06); }

      #nl-reply-textarea {
        width: 100%; min-height: 56px; max-height: 90px; padding: 6px 8px;
        border: 1px solid var(--nl-surface-border); border-radius: 8px; font-size: 11px;
        resize: vertical; font-family: inherit; outline: none; background: var(--nl-surface);
        color: var(--nl-text); line-height: 1.4;
      }
      #nl-reply-textarea:focus { border-color: var(--nl-primary); background: var(--nl-bg); }
      .nl-char-counter { font-size: 10px; color: var(--nl-text-muted); text-align: right; margin-top: -4px; }
      #nl-candidate-list { display: flex; flex-direction: column; gap: 5px; }
      .nl-candidate-card {
        padding: 6px 8px; border: 1px solid var(--nl-surface-border); border-radius: 7px;
        background: var(--nl-surface); color: var(--nl-text); cursor: pointer; font-size: 11px; line-height: 1.35;
        transition: 0.15s; text-align: left;
      }
      .nl-candidate-card:hover { border-color: var(--nl-primary); background: var(--nl-primary-light); }
      .nl-candidate-card.selected { border-color: var(--nl-primary); background: var(--nl-primary-light); font-weight: 600; }

      .nl-btn-action {
        width: 100%; padding: 7px 0; border-radius: 8px; border: none; font-size: 11.5px; font-weight: bold;
        cursor: pointer; transition: 0.15s; display: flex; align-items: center; justify-content: center; gap: 5px;
      }
      .nl-btn-action.generate { background: var(--nl-accent); color: #fff; }
      .nl-btn-action.generate:hover { opacity: 0.9; }
      .nl-btn-action.send { background: var(--nl-success); color: #fff; }
      .nl-btn-action.send:hover { opacity: 0.9; }
      .nl-btn-action:disabled { opacity: 0.45; cursor: not-allowed; }

      .nl-card-hint {
        padding: 6px 8px; border-radius: 6px; font-size: 10px; color: var(--nl-text-muted);
        background: var(--nl-surface); border: 1px dashed var(--nl-surface-border); line-height: 1.4;
      }

      .nl-growth-head-card {
        padding: 8px 10px; border-radius: 10px; background: var(--nl-surface);
        border: 1px solid var(--nl-surface-border); display: flex; align-items: center; gap: 10px;
      }
      .nl-gauge-wrapper { width: 56px; height: 56px; position: relative; display: grid; place-items: center; flex-shrink: 0; }
      .nl-gauge-svg { width: 56px; height: 56px; transform: rotate(-90deg); }
      .nl-gauge-bg { fill: none; stroke: var(--nl-surface-border); stroke-width: 4; }
      .nl-gauge-bar { fill: none; stroke: var(--nl-accent); stroke-width: 4; stroke-linecap: round; transition: stroke-dashoffset 0.6s ease; }
      .nl-gauge-text { position: absolute; font-size: 13px; font-weight: 800; color: var(--nl-text); }
      .nl-gauge-text small { font-size: 9px; font-weight: 600; }

      .nl-growth-head-info { display: flex; flex-direction: column; gap: 3px; flex: 1; }
      .nl-level-badge-row { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
      .nl-level-pill {
        padding: 2px 7px; border-radius: 5px; font-size: 11px; font-weight: 700;
        background: var(--nl-surface-border); color: var(--nl-text); white-space: nowrap;
      }
      .nl-level-pill.target { background: rgba(245, 158, 11, 0.15); color: #d97706; }
      .nl-account-status { font-size: 10px; color: var(--nl-success); display: flex; align-items: center; gap: 4px; }

      .nl-growth-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
      .nl-growth-card {
        padding: 6px 8px; border: 1px solid var(--nl-surface-border); border-radius: 8px;
        background: var(--nl-surface); display: flex; flex-direction: column; gap: 2px; min-width: 0;
      }
      .nl-growth-card.reached { border-color: rgba(16, 185, 129, 0.4); background: rgba(16, 185, 129, 0.03); }
      .nl-growth-card:last-child:nth-child(odd) { grid-column: span 2; }
      .nl-growth-card:last-child:nth-child(odd) .nl-card-nums { display: flex; align-items: baseline; gap: 6px; }

      .nl-card-top { display: flex; justify-content: space-between; align-items: center; }
      .nl-card-title { font-size: 10px; color: var(--nl-text-muted); display: flex; align-items: center; gap: 3px; }
      .nl-card-status { font-size: 9px; font-weight: 700; color: #d97706; white-space: nowrap; }
      .nl-growth-card.reached .nl-card-status { color: var(--nl-success); }
      .nl-card-nums { font-size: 13px; font-weight: 800; color: var(--nl-text); }
      .nl-card-nums small { font-size: 9.5px; font-weight: normal; color: var(--nl-text-muted); }
      .nl-card-bar-bg { height: 3.5px; background: var(--nl-surface-border); border-radius: 2px; overflow: hidden; margin-top: 2px; }
      .nl-card-bar-fill { height: 100%; background: var(--nl-accent); border-radius: 2px; transition: width 0.4s ease; }
      .nl-growth-card.reached .nl-card-bar-fill { background: var(--nl-success); }

      .nl-btn-sm {
        padding: 3px 8px; border-radius: 6px; border: 1px solid var(--nl-surface-border);
        background: var(--nl-surface); color: var(--nl-text); font-size: 10px; font-weight: 600;
        cursor: pointer; white-space: nowrap; line-height: 1.2; flex-shrink: 0;
      }
      .nl-btn-sm:hover { background: var(--nl-surface-hover); }

      #nl-log-box { display: flex; flex-direction: column; gap: 5px; max-height: 200px; overflow-y: auto; }
      .nl-log-item { border: 1px solid var(--nl-surface-border); border-radius: 6px; padding: 6px; font-size: 10px; }
      .nl-log-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; font-weight: 600; }
      .nl-log-content {
        white-space: pre-wrap; word-break: break-all; margin: 0; color: var(--nl-text-muted);
        font: 9.5px/1.4 monospace; background: var(--nl-surface); padding: 4px; border-radius: 4px;
      }
    `;

    function build() {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);

      el = document.createElement('div');
      el.id = 'nl-panel';
      if (collapsed) el.classList.add('is-collapsed');

      el.innerHTML = `
        <!-- 超轻量全能胶囊态：按住可拖动，支持快捷暂停、下一篇、成长TL直达 -->
        <div id="nl-mini-capsule" title="按住可拖拽移动，点击空白处展开面板">
          <span class="nl-pulse-dot" id="nl-capsule-dot"></span>
          <span id="nl-capsule-text">0% · 0s</span>
          <button class="nl-capsule-btn" id="nl-capsule-toggle" title="暂停/继续漫游">⏸</button>
          <button class="nl-capsule-btn" id="nl-capsule-skip" title="跳过当前帖，阅读下一篇">⏭</button>
          <button class="nl-capsule-btn growth" id="nl-capsule-growth" title="直达升级进度看板">📈 <span id="nl-capsule-tl-badge">TL</span></button>
        </div>

        <!-- 主面板 -->
        <div id="nl-card">
          <div id="nl-header">
            <div id="nl-header-title">
              <span>📖 NodeLoc 助手</span>
              <span id="nl-badge">v21.7.0 · JSON直读</span>
            </div>
            <button class="nl-icon-btn" id="nl-btn-collapse" title="折叠为微型胶囊">一</button>
          </div>

          <!-- 常驻双轨进度条与核心控制 -->
          <div id="nl-pinned-bar">
            <div id="nl-status">等待进入帖子...</div>
            <div class="nl-dual-progress">
              <!-- 滚动深度 -->
              <div class="nl-track-row">
                <span class="nl-track-label">滚动</span>
                <div class="nl-track-bg">
                  <div class="nl-track-fill scroll" id="nl-progress-fill"></div>
                </div>
                <span class="nl-track-val" id="nl-progress-pct">0%</span>
              </div>
              <!-- 驻留时长倒计时 -->
              <div class="nl-track-row">
                <span class="nl-track-label">驻留</span>
                <div class="nl-track-bg">
                  <div class="nl-track-fill dwell" id="nl-dwell-fill"></div>
                </div>
                <span class="nl-track-val" id="nl-dwell-pct">0s/120s</span>
              </div>
            </div>
            <div class="nl-quick-actions">
              <button class="nl-btn-quick primary" id="nl-pause-btn">⏸ 暂停</button>
              <button class="nl-btn-quick secondary" id="nl-skip-btn">⏭ 下一篇</button>
            </div>
          </div>

          <!-- Tabs 导航 -->
          <div id="nl-tabs">
            <button class="nl-tab-btn ${CFG.activeTab==='roam'?'active':''}" data-tab="roam">
              🚀 漫游
            </button>
            <button class="nl-tab-btn ${CFG.activeTab==='growth'?'active':''}" data-tab="growth">
              📈 成长 <span class="nl-tab-badge" id="nl-growth-tab-badge">TL</span>
            </button>
            <button class="nl-tab-btn ${CFG.activeTab==='ai'?'active':''}" data-tab="ai">
              🤖 回帖
            </button>
            <button class="nl-tab-btn ${CFG.activeTab==='cfg'?'active':''}" data-tab="cfg">
              ⚙️ 设置
            </button>
          </div>

          <div id="nl-body">
            <!-- TAB 1: 漫游控制 -->
            <div class="nl-tab-content ${CFG.activeTab==='roam'?'active':''}" id="nl-tab-roam">
              <div class="nl-slider-row">
                <label title="单帖目标驻留时长。Discourse约60s上报一次timing，推荐120s以上以稳定累积时长">单帖驻留</label>
                <input type="range" id="nl-target-dwell" min="45" max="300" step="15" value="${CFG.targetDwellTime}">
                <span class="nl-slider-val" id="nl-target-dwell-val">${CFG.targetDwellTime}s</span>
              </div>

              <div class="nl-row">
                <span class="nl-row-label">切走标签/最小化自动挂起</span>
                <label class="nl-toggle" title="仅在同窗口切走标签或窗口最小化时挂起。独立抽出窗口/分屏挂机不受影响。">
                  <input type="checkbox" id="nl-pause-on-hidden" ${CFG.pauseOnHidden?'checked':''}>
                  <span class="nl-track"></span>
                </label>
              </div>

              <div class="nl-pill-group">
                <button class="nl-pill-btn ${CFG.mode==='random'?'active':''}" data-mode="random">🎲 分段拟真(推荐)</button>
                <button class="nl-pill-btn ${CFG.mode==='uniform'?'active':''}" data-mode="uniform">🎯 匀速慢划</button>
              </div>

              <div id="nl-rand-section" class="${CFG.mode!=='random'?'hidden':''}">
                <div class="nl-slider-row">
                  <label>停顿精读率</label>
                  <input type="range" id="nl-pause-chance" min="1" max="10" step="1" value="${CFG.pauseChance}">
                  <span class="nl-slider-val" id="nl-pause-chance-val">${CFG.pauseChance}%</span>
                </div>
              </div>

              <div id="nl-uniform-section" class="${CFG.mode!=='uniform'?'hidden':''}">
                <div class="nl-slider-row">
                  <label>匀速速度</label>
                  <input type="range" id="nl-uniform-spd" min="1" max="6" step="1" value="${CFG.uniformSpeed}">
                  <span class="nl-slider-val" id="nl-uniform-spd-val">${CFG.uniformSpeed}</span>
                </div>
              </div>

              <div class="nl-row">
                <span class="nl-row-label">时长满后自动切帖</span>
                <label class="nl-toggle">
                  <input type="checkbox" id="nl-auto-next" ${CFG.autoNext?'checked':''}>
                  <span class="nl-track"></span>
                </label>
              </div>

              <div class="nl-card-hint">
                ⚡ 封顶强切已开启：单帖达到 6 分钟（360s）时长收益天花板时自动平滑跳走，长帖无需死等到底部。
              </div>

              <div class="nl-row" style="margin-top:auto; font-size:10px; color:var(--nl-text-muted)">
                <span>已读库: <b id="nl-read-count" style="color:var(--nl-primary)">${HistoryManager.count()}</b>/1000</span>
                <a id="nl-clear-btn" style="color:var(--nl-primary); cursor:pointer">清空记录</a>
              </div>
            </div>

            <!-- TAB 2: 成长指标看板（官方 JSON 接口直读） -->
            <div class="nl-tab-content ${CFG.activeTab==='growth'?'active':''}" id="nl-tab-growth">
              <!-- 用户名配置与切换栏 -->
              <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; background:var(--nl-surface); padding:5px 8px; border-radius:8px; border:1px solid var(--nl-surface-border);">
                <div style="display:flex; align-items:center; gap:4px; font-size:11px; overflow:hidden;">
                  <span style="color:var(--nl-text-muted); flex-shrink:0;">👤 账号:</span>
                  <input class="nl-input" type="text" id="nl-growth-user-input" value="${CFG.username}" placeholder="输入用户名(如 1751140932)" style="height:24px; padding:0 6px; font-size:11px; flex:1; min-width:80px;">
                </div>
                <button class="nl-btn-sm" id="nl-growth-user-save" style="padding:2px 7px; font-size:10px;">保存账号</button>
              </div>

              <div id="nl-growth-content"></div>

              <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;">
                <span id="nl-growth-time" style="font-size:10px; color:var(--nl-text-muted)">接口直读 · 0 闪烁</span>
                <button class="nl-btn-sm" id="nl-growth-refresh">↻ 刷新指标</button>
              </div>
            </div>

            <!-- TAB 3: 智能回帖（说人话强化版） -->
            <div class="nl-tab-content ${CFG.activeTab==='ai'?'active':''}" id="nl-tab-ai">
              <div id="nl-scene-badge" class="nl-card-hint" style="color:var(--nl-primary); font-weight:600; padding:4px 8px;">
                🌿 说人话 (shuorenhua) 去AI味引擎已就绪
              </div>
              <div id="nl-candidate-list"></div>
              <textarea id="nl-reply-textarea" placeholder="点击下方「💡 生成本帖候选」，自动去除AI味与模板套话，可在此微调..."></textarea>
              <div class="nl-char-counter" id="nl-char-counter">当前: 0 字</div>
              <div style="display:flex; gap:6px;">
                <button class="nl-btn-action generate" id="nl-generate-btn">💡 生成本帖候选</button>
                <button class="nl-btn-action send" id="nl-send-btn" disabled>🚀 确认发送</button>
              </div>
            </div>

            <!-- TAB 4: 设置与日志 -->
            <div class="nl-tab-content ${CFG.activeTab==='cfg'?'active':''}" id="nl-tab-cfg">
              <div class="nl-input-group">
                <label>NodeLoc 用户名 (用于成长看板 upgrade-progress.json):</label>
                <input class="nl-input" type="text" id="nl-ai-username-cfg" value="${CFG.username}" placeholder="例如: 1751140932">
              </div>

              <div class="nl-input-group">
                <label>快捷导入 NewAPI JSON:</label>
                <input class="nl-input" type="text" id="nl-ai-json-import" placeholder='{"key":"sk-...","url":"..."}'>
              </div>

              <div style="display:flex; gap:4px;">
                <select class="nl-input" id="nl-ai-format" style="flex:1">
                  <option value="openai" ${CFG.apiFormat==='openai'?'selected':''}>OpenAI</option>
                  <option value="anthropic" ${CFG.apiFormat==='anthropic'?'selected':''}>Anthropic</option>
                </select>
                <input class="nl-input" type="text" id="nl-ai-model" value="${CFG.modelName}" placeholder="模型名称" style="flex:1.5">
              </div>

              <div class="nl-input-group">
                <label>Base URL:</label>
                <input class="nl-input" type="text" id="nl-ai-url" value="${CFG.apiUrl}" placeholder="https://...">
              </div>

              <div class="nl-input-group">
                <label>API Key:</label>
                <input class="nl-input" type="password" id="nl-ai-key" value="${CFG.apiKey}" placeholder="sk-...">
              </div>

              <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
                <span style="font-weight:600; font-size:11px; white-space:nowrap;">调用日志 (最近10次)</span>
                <div style="display:flex; gap:6px; flex-shrink:0;">
                  <button class="nl-btn-sm" id="nl-copy-latest-log">📋 复制最新</button>
                  <button class="nl-btn-sm" id="nl-clear-logs">清空</button>
                </div>
              </div>
              <div id="nl-log-box"></div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(el);

      cardEl           = el.querySelector('#nl-card');
      miniCapsuleEl    = el.querySelector('#nl-mini-capsule');
      statusEl         = el.querySelector('#nl-status');
      statsEl          = el.querySelector('#nl-read-count');
      progressBarFill  = el.querySelector('#nl-progress-fill');
      dwellBarFill     = el.querySelector('#nl-dwell-fill');
      replyTextarea    = el.querySelector('#nl-reply-textarea');
      candidateList    = el.querySelector('#nl-candidate-list');
      sendBtn          = el.querySelector('#nl-send-btn');
      logBox           = el.querySelector('#nl-log-box');
      replyCharCounter = el.querySelector('#nl-char-counter');
      sceneBadge       = el.querySelector('#nl-scene-badge');

      const dragTracker = makeDraggable(el, [el.querySelector('#nl-header'), miniCapsuleEl]);

      function collapsePanel() {
        if (collapsed) return;
        const cardRect = cardEl.getBoundingClientRect();
        const cardRight = cardRect.right;
        const cardBottom = cardRect.bottom;

        collapsed = true;
        CFG.panelCollapsed = true;
        el.classList.add('is-collapsed');

        const capsuleRect = miniCapsuleEl.getBoundingClientRect();
        const w = capsuleRect.width || 230;
        const h = capsuleRect.height || 34;

        let nextLeft = cardRight - w;
        let nextTop = cardBottom - h;

        nextLeft = Math.max(10, Math.min(window.innerWidth - w - 10, nextLeft));
        nextTop = Math.max(10, Math.min(window.innerHeight - h - 10, nextTop));

        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.left = `${nextLeft}px`;
        el.style.top = `${nextTop}px`;
      }

      function expandPanel(targetTab = null) {
        if (!collapsed && !targetTab) return;
        const capsuleRect = miniCapsuleEl.getBoundingClientRect();
        const capsuleRight = capsuleRect.right;
        const capsuleBottom = capsuleRect.bottom;

        collapsed = false;
        CFG.panelCollapsed = false;
        el.classList.remove('is-collapsed');

        if (targetTab) {
          switchTab(targetTab);
        }

        const cardRect = cardEl.getBoundingClientRect();
        const w = cardRect.width || 338;
        const h = cardRect.height || 420;

        let nextLeft = capsuleRight - w;
        let nextTop = capsuleBottom - h;

        nextLeft = Math.max(10, Math.min(window.innerWidth - w - 10, nextLeft));
        nextTop = Math.max(10, Math.min(window.innerHeight - h - 10, nextTop));

        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.left = `${nextLeft}px`;
        el.style.top = `${nextTop}px`;
      }

      function switchTab(tab) {
        CFG.activeTab = tab;
        el.querySelectorAll('.nl-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        el.querySelectorAll('.nl-tab-content').forEach(c => c.classList.toggle('active', c.id === `nl-tab-${tab}`));
        if (tab === 'cfg') renderRequestLogs();
        if (tab === 'growth') refreshGrowthMetrics();
      }

      el.querySelector('#nl-btn-collapse').addEventListener('click', collapsePanel);

      miniCapsuleEl.addEventListener('click', (e) => {
        if (dragTracker.wasDragged()) return;
        if (e.target.closest('button')) return;
        expandPanel();
      });

      el.querySelector('#nl-capsule-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        scroller.togglePause();
        updatePauseBtn();
      });

      el.querySelector('#nl-capsule-skip').addEventListener('click', async (e) => {
        e.stopPropagation();
        replyStatusPinned = false;
        scroller.stop();
        panel.setStatus('正在挑选下一篇...');
        const url = await getNextTopicUrl();
        if (url) { navigateSpa(url); }
        else { panel.setStatus('未找到下一篇'); }
      });

      el.querySelector('#nl-capsule-growth').addEventListener('click', (e) => {
        e.stopPropagation();
        expandPanel('growth');
      });

      el.querySelectorAll('.nl-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
      });

      // 成长看板账号保存与刷新事件
      const userInput = el.querySelector('#nl-growth-user-input');
      const userSaveBtn = el.querySelector('#nl-growth-user-save');
      const cfgUserInput = el.querySelector('#nl-ai-username-cfg');

      function syncUsername(val) {
        CFG.username = val;
        if (userInput) userInput.value = val;
        if (cfgUserInput) cfgUserInput.value = val;
      }

      if (userSaveBtn) {
        userSaveBtn.addEventListener('click', () => {
          const val = userInput.value.trim();
          syncUsername(val);
          refreshGrowthMetrics();
        });
      }

      if (userInput) {
        userInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            syncUsername(userInput.value.trim());
            refreshGrowthMetrics();
          }
        });
      }

      if (cfgUserInput) {
        cfgUserInput.addEventListener('input', (e) => {
          syncUsername(e.target.value.trim());
        });
      }

      el.querySelector('#nl-growth-refresh').addEventListener('click', () => refreshGrowthMetrics());
      el.querySelector('#nl-clear-btn').addEventListener('click', () => HistoryManager.clear());

      const jsonImportInput = el.querySelector('#nl-ai-json-import');
      jsonImportInput.addEventListener('input', e => {
        const val = e.target.value.trim();
        try {
          const parsed = JSON.parse(val);
          if (parsed.key) { CFG.apiKey = parsed.key; el.querySelector('#nl-ai-key').value = parsed.key; }
          if (parsed.url) { CFG.apiUrl = parsed.url; el.querySelector('#nl-ai-url').value = parsed.url; }
          if (parsed.format) { CFG.apiFormat = parsed.format; el.querySelector('#nl-ai-format').value = parsed.format; }
          jsonImportInput.value = '✅ 导入成功！';
          setTimeout(() => { jsonImportInput.value = ''; }, 2000);
        } catch (err) {}
      });

      el.querySelector('#nl-ai-format').addEventListener('change', e => { CFG.apiFormat = e.target.value; });
      el.querySelector('#nl-ai-model').addEventListener('input', e => { CFG.modelName = e.target.value.trim(); });
      el.querySelector('#nl-ai-url').addEventListener('input', e => { CFG.apiUrl = e.target.value.trim(); });
      el.querySelector('#nl-ai-key').addEventListener('input', e => { CFG.apiKey = e.target.value.trim(); });

      bindSlider('#nl-target-dwell', '#nl-target-dwell-val', v => { CFG.targetDwellTime = v; return v + 's'; });
      bindSlider('#nl-uniform-spd', '#nl-uniform-spd-val', v => { CFG.uniformSpeed = v; return v; });
      bindSlider('#nl-pause-chance', '#nl-pause-chance-val', v => { CFG.pauseChance = v; return v + '%'; });

      el.querySelector('#nl-pause-on-hidden').addEventListener('change', e => { CFG.pauseOnHidden = e.target.checked; });
      el.querySelector('#nl-auto-next').addEventListener('change', e => { CFG.autoNext = e.target.checked; });

      el.querySelectorAll('.nl-pill-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const mode = btn.dataset.mode;
          CFG.mode = mode;
          el.querySelectorAll('.nl-pill-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
          el.querySelector('#nl-uniform-section').classList.toggle('hidden', mode !== 'uniform');
          el.querySelector('#nl-rand-section').classList.toggle('hidden', mode !== 'random');
        });
      });

      el.querySelector('#nl-pause-btn').addEventListener('click', () => {
        replyStatusPinned = false;
        scroller.togglePause();
        updatePauseBtn();
      });

      el.querySelector('#nl-skip-btn').addEventListener('click', async () => {
        replyStatusPinned = false;
        scroller.stop();
        panel.setStatus('正在挑选下一篇...');
        const url = await getNextTopicUrl();
        if (url) { navigateSpa(url); }
        else { panel.setStatus('未找到下一篇'); }
      });

      const genBtn = el.querySelector('#nl-generate-btn');
      genBtn.addEventListener('click', async () => {
        if (!isTopicPage()) {
          setStatus('请先进入具体的文章帖子页面');
          return;
        }

        if (scroller.active && !scroller.paused) {
          scroller.togglePause();
          updatePauseBtn();
        }

        resetReplyCandidates();
        genBtn.disabled = true;
        genBtn.textContent = '⏳ 正在研读全帖...';
        setStatus('🤖 结合主楼与最新多层讨论分析中...', true);

        try {
          const result = await AIReplyEngine.generateReply();
          if (sceneBadge && result.scene) {
            sceneBadge.textContent = `${result.scene.icon} 场景: ${result.scene.label} · 说人话模式已生效`;
          }

          if (result.rawCandidates.length === 0) {
            renderCandidateNotice('模型有返回但未解析出候选，请在「设置」中查看详情');
            setStatus('未识别出有效候选', true);
            genBtn.textContent = '🔄 换一组';
            return;
          }

          renderReplyCandidates(result.validCandidates.length > 0 ? result.validCandidates : result.rawCandidates);
          genBtn.textContent = '🔄 换一组';
          setStatus(`已生成 ${result.validCandidates.length} 条说人话候选，选用即可发送`, true);
        } catch (err) {
          renderCandidateNotice(`生成失败: ${err.message}`);
          setStatus(`生成失败: ${err.message}`, true);
          genBtn.textContent = '💡 生成本帖候选';
        } finally {
          genBtn.disabled = false;
        }
      });

      sendBtn.addEventListener('click', async () => {
        const text = replyTextarea.value.trim();
        if (!text) return;
        sendBtn.disabled = true;
        sendBtn.textContent = '🚀 发送中...';
        setStatus('正在发表回复(拟真延迟)...', true);

        try {
          await AIReplyEngine.submitReply(text);
          setStatus(`🎉 回复成功: "${text.slice(0, 16)}..."`, true);
          resetReplyCandidates();
          genBtn.textContent = '💡 生成本帖候选';
        } catch (err) {
          setStatus(`发送失败: ${err.message}`, true);
          sendBtn.disabled = false;
        } finally {
          sendBtn.textContent = '🚀 确认发送';
        }
      });

      replyTextarea.addEventListener('input', () => {
        const len = ReplyPipeline.getVisibleLength(replyTextarea.value);
        sendBtn.disabled = len === 0;
        if (replyCharCounter) {
          replyCharCounter.textContent = `当前: ${len} 字 (建议 8~30 字)`;
          replyCharCounter.style.color = (len >= 8 && len <= 30) ? 'var(--nl-success)' : 'var(--nl-text-muted)';
        }
      });

      function renderRequestLogs() {
        if (!logBox) return;
        const savedLogs = RequestLog.getAll().slice().reverse();
        logBox.replaceChildren();
        if (savedLogs.length === 0) {
          logBox.innerHTML = '<div style="color:var(--nl-text-muted); font-size:10px; text-align:center;">暂无日志</div>';
          return;
        }
        savedLogs.forEach((entry) => {
          const item = document.createElement('div');
          item.className = 'nl-log-item';
          const status = entry.result?.status || 'pending';
          item.innerHTML = `
            <div class="nl-log-meta">
              <span>${entry.createdAt || '未知'} · [${entry.request?.scene || '通用'}] ${status}</span>
              <a class="nl-log-copy" style="color:var(--nl-primary); cursor:pointer">复制</a>
            </div>
            <pre class="nl-log-content">${JSON.stringify({
              model: entry.request?.model,
              scene: entry.request?.scene,
              reply: entry.result?.rawReply || entry.result?.error
            }, null, 2)}</pre>
          `;
          item.querySelector('.nl-log-copy').addEventListener('click', () => {
            copyToClipboard(JSON.stringify(entry, null, 2));
            setStatus('已复制该条完整日志', true);
          });
          logBox.appendChild(item);
        });
      }

      el.querySelector('#nl-copy-latest-log').addEventListener('click', async () => {
        const logs = RequestLog.getAll();
        if (logs.length === 0) return setStatus('暂无日志', true);
        await copyToClipboard(JSON.stringify(logs[logs.length - 1], null, 2));
        setStatus('已复制最新日志', true);
      });

      el.querySelector('#nl-clear-logs').addEventListener('click', () => {
        RequestLog.clear();
        renderRequestLogs();
      });

      if (CFG.activeTab === 'growth') refreshGrowthMetrics();

      function resetReplyCandidates() {
        replyTextarea.value = '';
        candidateList.replaceChildren();
        sendBtn.disabled = true;
        if (replyCharCounter) replyCharCounter.textContent = '当前: 0 字';
      }

      function renderReplyCandidates(candidates) {
        candidateList.replaceChildren();
        candidates.forEach((cand, idx) => {
          const card = document.createElement('div');
          card.className = 'nl-candidate-card';
          card.textContent = `${idx + 1}. ${cand}`;
          card.addEventListener('click', () => {
            replyTextarea.value = cand;
            candidateList.querySelectorAll('.nl-candidate-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            sendBtn.disabled = false;
            const len = ReplyPipeline.getVisibleLength(cand);
            if (replyCharCounter) {
              replyCharCounter.textContent = `当前: ${len} 字 (建议 8~30 字)`;
              replyCharCounter.style.color = (len >= 8 && len <= 30) ? 'var(--nl-success)' : 'var(--nl-text-muted)';
            }
            setStatus('已选用候选，微调后即可发送', true);
          });
          candidateList.appendChild(card);
        });
      }

      function renderCandidateNotice(msg) {
        candidateList.replaceChildren();
        const notice = document.createElement('div');
        notice.className = 'nl-card-hint';
        notice.textContent = msg;
        candidateList.appendChild(notice);
      }
    }

    function getCleanBadgeName(lvl) {
      if (!lvl) return 'TL';
      if (lvl.includes('青铜')) return '青铜';
      if (lvl.includes('白银')) return '白银';
      if (lvl.includes('黄金')) return '黄金';
      if (lvl.includes('钻石')) return '钻石';
      if (lvl.includes('王者')) return '王者';
      return lvl.slice(0, 2);
    }

    function renderGrowthMetrics() {
      const content = el?.querySelector('#nl-growth-content');
      const timeEl = el?.querySelector('#nl-growth-time');
      const tabBadge = el?.querySelector('#nl-growth-tab-badge');
      const capsuleBadge = el?.querySelector('#nl-capsule-tl-badge');
      const growthState = GrowthMetrics.getState();
      if (!content) return;

      content.replaceChildren();

      // 用户名未配置提示
      if (!CFG.username) {
        content.innerHTML = `
          <div class="nl-card-hint" style="text-align:center; padding:16px 8px; display:flex; flex-direction:column; gap:6px;">
            <div style="font-weight:700; font-size:12px; color:var(--nl-text);">💡 请先填写你的 NodeLoc 用户名</div>
            <div style="font-size:10px; color:var(--nl-text-muted);">直接通过官方 JSON 接口读取，0 闪烁、不弹菜单、速度极快</div>
            <div style="font-size:10px; color:var(--nl-primary);">在上方输入框填入你的用户名（如 1751140932）并保存即可</div>
          </div>
        `;
        return;
      }

      if (growthState.loading) {
        content.innerHTML = '<div style="text-align:center; padding:20px 0; color:var(--nl-text-muted); font-size:11px;">⏳ 正在通过官方 JSON 接口读取升级进度...</div>';
        return;
      }
      if (!growthState.data) {
        content.innerHTML = `<div style="text-align:center; padding:20px 0; color:var(--nl-text-muted); font-size:11px;">${growthState.error || '暂无成长指标，请点击刷新'}</div>`;
        return;
      }

      const data = growthState.data;
      const cleanName = getCleanBadgeName(data.currentLevel);
      if (tabBadge && cleanName) tabBadge.textContent = cleanName;
      if (capsuleBadge && cleanName) capsuleBadge.textContent = cleanName;

      const headCard = document.createElement('div');
      headCard.className = 'nl-growth-head-card';

      const circumference = 2 * Math.PI * 23;
      const offset = circumference - (Math.min(100, data.overallPercent) / 100) * circumference;

      headCard.innerHTML = `
        <div class="nl-gauge-wrapper">
          <svg class="nl-gauge-svg" viewBox="0 0 56 56">
            <circle class="nl-gauge-bg" cx="28" cy="28" r="23"></circle>
            <circle class="nl-gauge-bar" cx="28" cy="28" r="23" style="stroke-dasharray:${circumference}; stroke-dashoffset:${offset};"></circle>
          </svg>
          <div class="nl-gauge-text">${data.overallPercent}<small>%</small></div>
        </div>
        <div class="nl-growth-head-info">
          <div class="nl-level-badge-row">
            <span class="nl-level-pill">${data.currentLevel}</span>
            <span style="color:var(--nl-text-muted)">➔</span>
            <span class="nl-level-pill target">${data.nextLevel}</span>
          </div>
          <div style="font-size:10px; color:var(--nl-text-muted); margin-top:2px;">
            达标: <b style="color:var(--nl-success)">${data.satisfiedCount}</b> 项 · 待达成: <b style="color:var(--nl-accent)">${data.unmetCount}</b> 项
          </div>
          <div class="nl-account-status">
            <span>●</span> 账号状态: ${data.accountStatus}
          </div>
        </div>
      `;

      const grid = document.createElement('div');
      grid.className = 'nl-growth-grid';

      data.metrics.forEach(m => {
        const card = document.createElement('div');
        card.className = `nl-growth-card${m.reached ? ' reached' : ''}`;
        const diff = Math.max(0, m.target - m.value);
        const statusText = m.reached ? '✔ 已达标' : `差 ${diff}${m.unit}`;

        card.innerHTML = `
          <div class="nl-card-top">
            <span class="nl-card-title">${m.icon || '📌'} ${m.label}</span>
            <span class="nl-card-status">${statusText}</span>
          </div>
          <div class="nl-card-nums">
            ${m.value} <small>/ ${m.target}${m.unit ? ' ' + m.unit : ''}</small>
          </div>
          <div class="nl-card-bar-bg">
            <div class="nl-card-bar-fill" style="width:${Math.min(100, m.progress)}%"></div>
          </div>
        `;
        grid.appendChild(card);
      });

      content.append(headCard, grid);
      if (timeEl && growthState.updatedAt) {
        timeEl.textContent = `已同步 [${CFG.username}]: ${growthState.updatedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
      }
    }

    async function refreshGrowthMetrics() {
      const refreshBtn = el?.querySelector('#nl-growth-refresh');
      if (GrowthMetrics.getState().loading) return;
      if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '⏳ 读取中...';
      }
      renderGrowthMetrics();
      await GrowthMetrics.refresh();
      renderGrowthMetrics();
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = '↻ 刷新指标';
      }
    }

    function makeDraggable(container, handles) {
      let isDragging = false;
      let startX = 0, startY = 0;
      let startLeft = 0, startTop = 0;
      let didDrag = false;
      let wasJustDragged = false;

      const handleList = Array.isArray(handles) ? handles : [handles];

      handleList.forEach(handle => {
        if (!handle) return;
        handle.addEventListener('mousedown', e => {
          if (e.target.closest('button') || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
          isDragging = true;
          didDrag = false;
          startX = e.clientX;
          startY = e.clientY;

          const rect = container.getBoundingClientRect();
          startLeft = rect.left;
          startTop = rect.top;

          container.style.right = 'auto';
          container.style.bottom = 'auto';
          container.style.left = `${startLeft}px`;
          container.style.top = `${startTop}px`;
          e.preventDefault();
        });
      });

      window.addEventListener('mousemove', e => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!didDrag && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
          didDrag = true;
        }
        if (!didDrag) return;

        const maxW = container.offsetWidth || 230;
        const maxH = container.offsetHeight || 40;
        const nextLeft = Math.max(10, Math.min(window.innerWidth - maxW - 10, startLeft + dx));
        const nextTop = Math.max(10, Math.min(window.innerHeight - maxH - 10, startTop + dy));

        container.style.left = `${nextLeft}px`;
        container.style.top = `${nextTop}px`;
      });

      window.addEventListener('mouseup', () => {
        if (isDragging) {
          isDragging = false;
          if (didDrag) {
            wasJustDragged = true;
            setTimeout(() => { wasJustDragged = false; }, 120);
          }
        }
      });

      return {
        wasDragged: () => wasJustDragged
      };
    }

    function bindSlider(inputSel, valSel, onChange) {
      const input = el.querySelector(inputSel);
      const valEl = el.querySelector(valSel);
      input.addEventListener('input', () => {
        valEl.textContent = onChange(Number(input.value));
      });
    }

    function setStatus(txt, shouldPin = false) {
      replyStatusPinned = shouldPin;
      if (statusEl) statusEl.textContent = txt;
    }

    function setActivityStatus(txt) {
      if (!replyStatusPinned && statusEl) statusEl.textContent = txt;
    }

    function updateLiveMetrics(pct, dwell, target, timings) {
      if (progressBarFill) progressBarFill.style.width = `${pct}%`;
      const progressPctEl = el?.querySelector('#nl-progress-pct');
      if (progressPctEl) progressPctEl.textContent = `${pct}%`;

      if (dwellBarFill) {
        const dwellPct = Math.min(100, Math.round((dwell / target) * 100));
        dwellBarFill.style.width = `${dwellPct}%`;
      }
      const dwellPctEl = el?.querySelector('#nl-dwell-pct');
      if (dwellPctEl) dwellPctEl.textContent = `${dwell}s/${target}s`;

      const capsuleText = el?.querySelector('#nl-capsule-text');
      if (capsuleText) capsuleText.textContent = `${pct}% · ${dwell}s`;
    }

    function updateStats() {
      if (!statsEl && el) statsEl = el.querySelector('#nl-read-count');
      if (statsEl) statsEl.textContent = HistoryManager.count();
    }

    function updatePauseBtn() {
      const btn = el && el.querySelector('#nl-pause-btn');
      const capBtn = el && el.querySelector('#nl-capsule-toggle');
      const capDot = el && el.querySelector('#nl-capsule-dot');
      if (!btn) return;

      const isPaused = scroller.paused || scroller.pausedByHidden;
      if (!scroller.active) {
        btn.textContent = '▶ 开始'; btn.className = 'nl-btn-quick primary';
        if (capBtn) capBtn.textContent = '▶';
        if (capDot) capDot.classList.add('paused');
      } else if (isPaused) {
        btn.textContent = '▶ 恢复'; btn.className = 'nl-btn-quick primary';
        if (capBtn) capBtn.textContent = '▶';
        if (capDot) capDot.classList.add('paused');
      } else {
        btn.textContent = '⏸ 暂停'; btn.className = 'nl-btn-quick secondary';
        if (capBtn) capBtn.textContent = '⏸';
        if (capDot) capDot.classList.remove('paused');
      }
    }

    return { build, setStatus, setActivityStatus, updateLiveMetrics, updateStats, updatePauseBtn };
  })();

  // ============================================================
  // AutoScroller 实例与路由事件监听
  // ============================================================
  const scroller = new AutoScroller();
  let currentPath = window.location.pathname;

  function handleRouteChange() {
    const np = window.location.pathname;
    if (np === currentPath) return;
    currentPath = np;
    scroller.stop();
    panel.updatePauseBtn();
    if (isTopicPage()) {
      panel.setStatus('进入新贴，准备拟真漫游...');
      WorkerTimer.setTimeout(() => { scroller.start(); panel.updatePauseBtn(); }, 1200);
    } else {
      panel.setStatus('请点击帖子进入阅读');
    }
  }

  document.addEventListener('visibilitychange', () => scroller.onVisibilityChange());

  window.addEventListener('popstate', handleRouteChange);
  (function patchHistory() {
    const orig = { push: history.pushState.bind(history), replace: history.replaceState.bind(history) };
    history.pushState   = (...a) => { orig.push(...a);    setTimeout(handleRouteChange, 100); };
    history.replaceState = (...a) => { orig.replace(...a); setTimeout(handleRouteChange, 100); };
  })();

  let _mut = null;
  new MutationObserver(() => {
    if (_mut) return;
    _mut = setTimeout(() => { _mut = null; handleRouteChange(); }, 300);
  }).observe(document.body, { childList: true, subtree: true });

  // 键盘快捷键
  document.addEventListener('keydown', e => {
    if (['INPUT','TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable) return;
    if (e.key === 'p' || e.key === 'P') {
      scroller.togglePause();
      panel.updatePauseBtn();
    }
    if (e.key === 's' || e.key === 'S') {
      scroller.stop();
      getNextTopicUrl().then(url => { if (url) navigateSpa(url); });
    }
  });

  // 初始化入口
  function init() {
    // 优先尝试自动预填当前登录用户名
    if (!CFG.username) {
      const detected = detectCurrentUsername();
      if (detected) CFG.username = detected;
    }

    panel.build();
    if (isTopicPage()) {
      WorkerTimer.setTimeout(() => { scroller.start(); panel.updatePauseBtn(); }, 1500);
    } else {
      panel.setStatus('请点击帖子进入阅读');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
