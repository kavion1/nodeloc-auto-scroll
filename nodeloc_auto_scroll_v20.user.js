// ==UserScript==
// @name         NodeLoc Auto Scroll & Evidence-Grounded Replier (v20 - 完整日志一键复制版)
// @namespace    http://tampermonkey.net/
// @version      20.0
// @description  NodeLoc 自动漫游 + 有依据的人工确认回帖：增加日志右上角悬浮复制按钮（完整导出无截断提示词与模型返回）、自动暂停防切帖、全楼层滑动窗口防超时、解锁手动打字与正常提问自由。
// @author       AutoScroll
// @match        https://www.nodeloc.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // Web Worker 独立线程定时器（后台标签页全速不降频）
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
        console.warn('[NodeLoc v20] Worker 初始化失败，降级使用原生计时器:', err);
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

  // 请求日志持久化存储（保留完整未截断的上下文与模型返回，最近 10 次）
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

  // 剪贴板复制工具函数
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
    // 漫游基础配置
    get mode()              { return STORE.get('nl_mode', 'random'); },
    set mode(v)             { STORE.set('nl_mode', v); },
    get uniformSpeed()      { return STORE.get('nl_uniformSpeed', 2); },
    set uniformSpeed(v)     { STORE.set('nl_uniformSpeed', v); },
    get randomSpeedMin()    { return STORE.get('nl_randMin', 1); },
    set randomSpeedMin(v)   { STORE.set('nl_randMin', v); },
    get randomSpeedMax()    { return STORE.get('nl_randMax', 4); },
    set randomSpeedMax(v)   { STORE.set('nl_randMax', v); },
    get pauseChance()       { return STORE.get('nl_pauseChance', 3); },
    set pauseChance(v)      { STORE.set('nl_pauseChance', v); },
    get pauseDuration()     { return STORE.get('nl_pauseDur', 800); },
    set pauseDuration(v)    { STORE.set('nl_pauseDur', v); },
    get autoNext()          { return STORE.get('nl_autoNext', true); },
    set autoNext(v)         { STORE.set('nl_autoNext', v); },
    get bottomWait()        { return STORE.get('nl_bottomWait', 3000); },
    set bottomWait(v)       { STORE.set('nl_bottomWait', v); },
    get panelCollapsed()    { return STORE.get('nl_collapsed', false); },
    set panelCollapsed(v)   { STORE.set('nl_collapsed', v); },

    // API 配置
    get apiFormat()         { return STORE.get('nl_api_format', 'anthropic'); },
    set apiFormat(v)        { STORE.set('nl_api_format', v); },
    get apiUrl()            { return STORE.get('nl_api_url', 'https://tabitoken.com'); },
    set apiUrl(v)           { STORE.set('nl_api_url', v); },
    get apiKey()            { return STORE.get('nl_api_key', ''); },
    set apiKey(v)           { STORE.set('nl_api_key', v); },
    get modelName()         { return STORE.get('nl_api_model', 'claude-opus-4-8'); },
    set modelName(v)        { STORE.set('nl_api_model', v); },
    get showAiCfg()         { return STORE.get('nl_show_ai_cfg', false); },
    set showAiCfg(v)        { STORE.set('nl_show_ai_cfg', v); }
  };

  // ============================================================
  // 已读历史管理器（200篇容量）
  // ============================================================
  const HistoryManager = {
    MAX: 200,
    getAll() { return STORE.get('nl_visited_ids', []); },
    add(id) {
      if (!id) return;
      id = String(id);
      let list = this.getAll().filter(x => x !== id);
      list.push(id);
      if (list.length > this.MAX) list = list.slice(list.length - this.MAX);
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

  const log = (...a) => console.log('[NodeLoc v20]', ...a);

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
  function isAtBottom() { return getScrollY() >= getMaxScroll() - 160; }

  // ============================================================
  // 回复上下文筛选与候选质量校验管道
  // ============================================================
  const ReplyPipeline = {
    BANNED_PATTERNS: [
      /感谢.{0,4}分享/i, /干货满满/i, /值得收藏/i, /受益匪浅/i,
      /很有参考价值/i, /总结.{0,4}到位/i, /思路清晰/i, /深入浅出/i,
      /写得很好/i, /很有深度/i, /作为\s*(?:ai|人工智能)/i
    ],

    AGGRESSIVE_PATTERNS: [
      /傻[子逼瓜]?/i, /蠢/i, /垃圾/i, /废物/i, /智商/i,
      /笑死/i, /活该/i, /割韭菜/i, /脑残/i, /骗[子钱]?/i
    ],

    getVisibleLength(text) {
      return Array.from(String(text || '')).filter(char => !/\s/.test(char)).length;
    },

    selectMainFacts(mainContent, title) {
      const rawSentences = String(mainContent || '')
        .split(/[。！？；\r\n]+/)
        .map(s => s.trim())
        .filter(s => this.getVisibleLength(s) >= 6);

      const titleTerms = String(title || '').match(/[a-z][a-z0-9._-]{1,}/ig) || [];
      const factPattern = /\d|ip|ipv[46]|vps|cpu|内存|流量|带宽|延迟|丢包|端口|套餐|配置|测速|解锁|系统|价格|费用|保号|信号|开卡|注册|激活|护照|支付|余额|验证码/i;
      const keySectionPattern = /费用|保号|信号|开卡|注册|激活|护照|支付|余额|验证码|条件|步骤|规则/i;

      return rawSentences.map((sentence, index) => ({
        sentence,
        index,
        score: (factPattern.test(sentence) ? 2 : 0)
          + (keySectionPattern.test(sentence) ? 3 : 0)
          + (titleTerms.some(term => sentence.toLowerCase().includes(term.toLowerCase())) ? 4 : 0)
      }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map(item => item.sentence)
        .filter((sentence, idx, arr) => arr.indexOf(sentence) === idx)
        .slice(0, 5);
    },

    isCandidateValid(candidate) {
      const isBanned = this.BANNED_PATTERNS.some(p => p.test(candidate));
      const isAggressive = this.AGGRESSIVE_PATTERNS.some(p => p.test(candidate));
      const len = this.getVisibleLength(candidate);
      const isLengthValid = len >= 8 && len <= 45;
      return !isBanned && !isAggressive && isLengthValid;
    },

    validateCandidates(candidates) {
      const validCandidates = [];
      const candidateChecks = [];

      for (const rawCandidate of candidates || []) {
        const candidate = String(rawCandidate || '').replace(/。+$/, '').trim();
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
        if (char === '"') {
          inString = true;
        } else if (char === openingChar) {
          depth++;
        } else if (char === closingChar) {
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
        .map(line => line.replace(/^\s*(?:[-*]|(?:候选\s*)?\d+[.、):：])\s*/, '').trim())
        .filter(line => line.length >= 4 && !/[\[{]/.test(line))
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
            .map(item => this.getCandidateText(item))
            .filter(Boolean)
            .slice(0, 3);
          parseMode = 'json';
        } catch (err) {
          log('JSON 解析失败，降级逐行解析', err.message);
        }
      }
      if (candidates.length === 0) {
        candidates = this.extractLineCandidates(normalized);
        if (candidates.length > 0) parseMode = 'line_fallback';
      }
      return { candidates, parseMode };
    }
  };

  // ============================================================
  // 有依据的 AI 回复生成与人工发送引擎
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
        log('API 楼层获取失败，使用已渲染楼层', err.message);
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
      const posts = (apiPosts.length > 0 ? apiPosts : loadedPosts)
        .slice()
        .sort((a, b) => a.postNumber - b.postNumber);

      const apiMainPost = posts.find(p => p.postNumber === 1);
      if (apiMainPost && apiMainPost.text) {
        mainContent = apiMainPost.text.slice(0, 900);
      }

      // 安全滑动窗口：取最近 10 条回复，单条限 120 字
      const rawReplies = posts.filter(p => p.postNumber > 1 && p.text);
      const recentReplies = rawReplies.slice(-10);
      const allReplies = recentReplies.map(p => `【${p.postNumber}楼 @${p.username}】：${p.text.slice(0, 120)}`);

      const mainFacts = ReplyPipeline.selectMainFacts(mainContent, title);
      const sourceText = [title, mainContent, ...allReplies].filter(Boolean).join('\n');

      return {
        title,
        mainContent,
        mainFacts,
        allReplies,
        imageInfo: imageDescriptions.length > 0 ? imageDescriptions.join('、') : '无图片',
        sourceText
      };
    },

    async generateReply() {
      if (!CFG.apiKey || !CFG.apiUrl) {
        throw new Error('请先在「⚙️ API 配置」中填入 API Key 和 Base URL');
      }

      const ctx = await this.getTopicFullContext();

      const systemPrompt = `你是一个活跃在 NodeLoc / Linux.do 论坛的技术爱好者，正在手机上随和地浏览帖子并准备跟帖交流。
请根据提供的帖子标题、主楼事实与楼下各楼层讨论，生成三条风格不同、自然实在、友善中肯的口语化候选回复。

【规则与红线】：
1. 态度友善和气，严禁任何主观恶意、阴阳怪气、戾气、无端嘲讽或攻击。
2. 严禁任何AI假大空套话（如“感谢分享/干货满满/受益匪浅/很有参考价值/总结到位/思路清晰/深入浅出”等）。
3. 必须紧密结合主楼事实、图片信息或顺着楼下网友讨论的话题发表看法或经验交流。
4. 每条候选长度控制在 10 到 35 个汉字，口语自然，末尾不加句号。

【输出格式要求】：
必须仅输出一个合法 JSON 对象，格式严格如下（严禁任何 Markdown 标记或多余解释）：
{"candidates":["候选回复1","候选回复2","候选回复3"]}`;

      const userPrompt = `【帖子标题】：${ctx.title}
【主楼核心事实】：
${ctx.mainFacts.join('\n') || ctx.mainContent || '（无可用正文）'}
【主楼附带图片】：${ctx.imageInfo}
【楼下最新讨论】：
${ctx.allReplies.join('\n') || '（暂无其他回复，你是前排）'}

请输出 3 条自然、友善、切合主题的候选回复 JSON：`;

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
          title: ctx.title
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

        log('发起 AI 候选请求:', requestUrl, '模型:', CFG.modelName);

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
                log('AI 原始返回:', modelReply);

                const payload = ReplyPipeline.parseModelResponse(modelReply);
                const validation = ReplyPipeline.validateCandidates(payload.candidates);

                RequestLog.update(requestLogId, {
                  status: 'success',
                  rawReply: modelReply,
                  parseMode: payload.parseMode,
                  rawCandidates: payload.candidates,
                  validCandidates: validation.validCandidates,
                  candidateChecks: validation.candidateChecks,
                  shouldReply: validation.shouldReply
                });

                resolve({
                  parseMode: payload.parseMode,
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
  // 随机速度引擎
  // ============================================================
  const HumanEngine = {
    _pausing: false,
    _pauseUntil: 0,
    _jitter(base, range) { return base + (Math.random() * 2 - 1) * range; },
    getScrollPx() {
      const now = Date.now();
      if (this._pausing && now < this._pauseUntil) return 0;
      if (this._pausing && now >= this._pauseUntil) this._pausing = false;
      if (Math.random() * 100 < CFG.pauseChance) {
        this._pausing = true;
        this._pauseUntil = now + this._jitter(CFG.pauseDuration, CFG.pauseDuration * 0.4);
        return 0;
      }
      const lo = CFG.randomSpeedMin, hi = CFG.randomSpeedMax;
      const raw = lo + Math.pow(Math.random(), 1.5) * (hi - lo);
      return Math.max(0, Math.round(this._jitter(raw, 0.5)));
    }
  };

  // ============================================================
  // 目标选取算法（推荐随机 + 已读过滤 + API无尽漫游）
  // ============================================================
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
    if (allHist.length > 100) STORE.set('nl_visited_ids', allHist.slice(100));
    else HistoryManager.clear();

    if (domCandidates.length > 0) return domCandidates[Math.floor(Math.random() * domCandidates.length)].url;
    return window.location.origin + '/latest';
  }

  // ============================================================
  // AutoScroller 核心控制器（纯漫游，绝不自动发送回复）
  // ============================================================
  class AutoScroller {
    constructor() {
      this.active = false;
      this.paused = false;
      this.bottomReached = false;
      this._timerId = null;
      this._bottomTimerId = null;
      this._tickCount = 0;
    }

    start() {
      if (this.active) return;
      this.active = true;
      this.paused = false;
      this.bottomReached = false;
      HumanEngine._pausing = false;

      const curId = getTopicId();
      if (curId) HistoryManager.add(curId);

      log('启动漫游, 模式:', CFG.mode);
      this._schedule();
    }

    stop() {
      this.active = false;
      this._clearTimers();
      log('停止漫游');
    }

    togglePause() {
      if (!this.active) { this.start(); return; }
      this.paused = !this.paused;
      if (!this.paused) HumanEngine._pausing = false;
      log(this.paused ? '手动暂停' : '恢复滚动');
    }

    _clearTimers() {
      if (this._timerId) { WorkerTimer.clearTimeout(this._timerId); this._timerId = null; }
      if (this._bottomTimerId) { WorkerTimer.clearTimeout(this._bottomTimerId); this._bottomTimerId = null; }
    }

    _schedule() {
      const interval = CFG.mode === 'uniform' ? 30 : Math.round(25 + Math.random() * 55);
      this._timerId = WorkerTimer.setTimeout(() => {
        if (!this.active) return;
        this._tick();
        if (this.active && !this.bottomReached) this._schedule();
      }, interval);
    }

    _tick() {
      if (!this.active || this.paused || this.bottomReached) return;
      this._tickCount++;

      if (isAtBottom()) {
        this.bottomReached = true;
        panel.setActivityStatus(`已到底部，${(CFG.bottomWait/1000).toFixed(1)}秒后切帖...`);
        this._bottomTimerId = WorkerTimer.setTimeout(() => this._navigateNext(), CFG.bottomWait);
        return;
      }

      let px = CFG.mode === 'uniform' ? CFG.uniformSpeed : HumanEngine.getScrollPx();
      if (px > 0) window.scrollBy(0, px);

      if (this._tickCount % 25 === 0) {
        const pct = Math.min(100, Math.round(getScrollY() / Math.max(getMaxScroll(), 1) * 100));
        panel.setActivityStatus(`${CFG.mode === 'uniform' ? '🎯 匀速' : '🎲 随机'} 阅读中 ${pct}% ⚡后台保活`);
      }
    }

    async _navigateNext() {
      if (!CFG.autoNext) {
        this.stop();
        panel.setStatus('已到底部（未开启自动跳转）');
        return;
      }
      panel.setStatus('正在挑选下一篇...');
      const url = await getNextTopicUrl();
      if (url) {
        panel.setStatus('正在跳转下一篇...');
        WorkerTimer.setTimeout(() => { window.location.href = url; }, 400);
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
    let el, statusEl, statsEl, replyTextarea, candidateList, sendBtn, logBox, logList, collapsed = CFG.panelCollapsed;
    let replyStatusPinned = false;

    const css = `
      #nl-panel {
        position: fixed; right: 18px; bottom: 24px; z-index: 2147483647;
        font: 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif;
        color: #1a1a1a; user-select: none;
      }
      #nl-panel * { box-sizing: border-box; }
      #nl-card {
        background: rgba(255,255,255,0.98);
        border: 1px solid rgba(0,0,0,0.12);
        border-radius: 14px;
        box-shadow: 0 6px 30px rgba(0,0,0,0.18);
        min-width: 270px; max-width: 330px; overflow: hidden;
        transition: height 0.2s ease;
      }
      #nl-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 9px 14px 8px;
        background: linear-gradient(135deg,#0a7cff 0%,#0055d4 100%);
        color: #fff; cursor: pointer; border-radius: 13px 13px 0 0;
      }
      #nl-header.collapsed { border-radius: 13px; }
      #nl-title { font-weight: 700; font-size: 13px; letter-spacing: 0.2px; }
      #nl-badge {
        background: rgba(255,255,255,0.25); font-size: 10px; padding: 1px 6px;
        border-radius: 10px; margin-left: 6px;
      }
      #nl-toggle-collapse { background: none; border: none; color: #fff; cursor: pointer; font-size: 14px; padding: 0; }
      #nl-body { padding: 10px 14px 12px; display: flex; flex-direction: column; gap: 8px; max-height: 85vh; overflow-y: auto; }
      #nl-status {
        font-size: 11px; color: #444; background: #f4f6f8;
        border-radius: 6px; padding: 5px 8px; min-height: 26px;
        display: flex; align-items: center; word-break: break-all;
      }
      .nl-stats-bar { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #666; }
      .nl-clear-link { color: #0a7cff; cursor: pointer; text-decoration: none; }
      .nl-clear-link:hover { text-decoration: underline; }

      /* AI 手动回复助手区域 */
      #nl-manual-ai-box {
        background: #f4f8ff; border: 1.5px solid #bcd3ff; border-radius: 10px;
        padding: 9px; display: flex; flex-direction: column; gap: 7px;
      }
      .nl-ai-header {
        display: flex; align-items: center; justify-content: space-between;
        font-size: 12px; font-weight: bold; color: #0a7cff;
      }
      #nl-reply-textarea {
        width: 100%; min-height: 52px; max-height: 90px; padding: 6px 8px;
        border: 1px solid #bcd3ff; border-radius: 6px; font-size: 12px;
        resize: vertical; font-family: inherit; outline: none; background: #fff; line-height: 1.4;
      }
      #nl-reply-textarea:focus { border-color: #0a7cff; box-shadow: 0 0 0 2px rgba(10,124,255,0.15); }
      #nl-candidate-list { display: flex; flex-direction: column; gap: 5px; }
      #nl-candidate-list.hidden { display: none; }
      .nl-candidate {
        width: 100%; min-height: 30px; padding: 6px 8px; text-align: left;
        border: 1px solid #cbd7e7; border-radius: 5px; background: #fff;
        color: #263545; cursor: pointer; font: inherit; font-size: 12px; line-height: 1.35;
      }
      .nl-candidate:hover, .nl-candidate.selected { border-color: #0a7cff; background: #eaf3ff; }
      .nl-candidate-title { font-size: 11px; color: #516174; font-weight: 600; }
      .nl-candidate-notice { padding: 6px 8px; border: 1px dashed #d6a95c; border-radius: 5px; color: #805c1d; background: #fffdf5; font-size: 11px; line-height: 1.4; }
      .nl-ai-actions { display: flex; align-items: center; gap: 8px; }
      .nl-link-button {
        border: 0; background: none; color: #0a7cff; cursor: pointer; padding: 0;
        font: inherit; font-size: 11px; font-weight: normal;
      }
      .nl-link-button:hover { text-decoration: underline; }

      /* 日志区域 */
      #nl-log-box {
        display: flex; flex-direction: column; gap: 6px; max-height: 250px; overflow-y: auto;
        border: 1px solid #dce5f2; border-radius: 7px; padding: 7px; background: #fff;
      }
      #nl-log-box.hidden { display: none; }
      .nl-log-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #516174; }
      
      .nl-log-item {
        position: relative;
        border-top: 1px solid #edf1f5;
        padding-top: 6px;
        margin-top: 4px;
      }
      .nl-log-item:first-child { border-top: 0; padding-top: 0; margin-top: 0; }
      .nl-log-item-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }
      .nl-log-item summary {
        cursor: pointer;
        color: #34495e;
        font-size: 11px;
        font-weight: 600;
        flex: 1;
        outline: none;
      }
      .nl-log-copy-btn {
        background: #eaf3ff;
        border: 1px solid #bcd3ff;
        color: #0a7cff;
        border-radius: 4px;
        padding: 2px 6px;
        font-size: 10px;
        cursor: pointer;
        font-weight: 500;
        transition: 0.15s;
        line-height: 1.2;
        flex-shrink: 0;
      }
      .nl-log-copy-btn:hover {
        background: #0a7cff;
        color: #fff;
        border-color: #0a7cff;
      }
      .nl-log-content {
        margin: 5px 0 0; white-space: pre-wrap; word-break: break-word; user-select: text;
        font: 10px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: #445;
        background: #f8fafc; padding: 6px; border-radius: 5px;
      }
      .nl-log-empty { padding: 4px 0; color: #8a94a3; font-size: 11px; text-align: center; }

      /* API 配置折叠区 */
      .nl-ai-cfg-box {
        display: flex; flex-direction: column; gap: 5px; background: #fff;
        border: 1px solid #dce5f2; border-radius: 7px; padding: 7px; font-size: 11px;
      }
      .nl-ai-cfg-box.hidden, #nl-rand-section.hidden, #nl-uniform-section.hidden { display: none; }
      .nl-input-row { display: flex; flex-direction: column; gap: 2px; font-size: 11px; }
      .nl-input-row input, .nl-input-row select {
        padding: 4px 6px; border: 1px solid #ccd6e5; border-radius: 5px; font-size: 11px; outline: none;
      }
      .nl-input-row input:focus, .nl-input-row select:focus { border-color: #0a7cff; }

      .nl-mode-group { display: flex; gap: 5px; }
      .nl-mode-btn {
        flex: 1; padding: 5px 0; border-radius: 7px; border: 1.5px solid #d0d7de;
        background: #fff; color: #444; font-size: 11px; font-weight: 600; cursor: pointer; transition: 0.15s;
      }
      .nl-mode-btn.active { background: #0a7cff; border-color: #0a7cff; color: #fff; }
      .nl-btn-row { display: flex; gap: 6px; }
      .nl-btn {
        flex: 1; padding: 7px 0; border-radius: 7px; border: none;
        font-size: 12px; font-weight: bold; cursor: pointer; transition: 0.15s;
        display: flex; align-items: center; justify-content: center; gap: 4px;
      }
      .nl-btn.primary { background: #0a7cff; color: #fff; }
      .nl-btn.primary:hover { background: #0062cc; }
      .nl-btn.generate { background: #ff9800; color: #fff; }
      .nl-btn.generate:hover { background: #e68900; }
      .nl-btn.confirm  { background: #28a745; color: #fff; }
      .nl-btn.confirm:hover  { background: #218838; }
      .nl-btn:disabled { cursor: not-allowed; opacity: 0.5; }
      .nl-btn.secondary { background: #f1f3f5; color: #333; font-weight: normal; }
      .nl-btn.secondary:hover { background: #e2e6ea; }

      .nl-slider-row { display: flex; align-items: center; gap: 6px; font-size: 11px; }
      .nl-slider-row label { flex: 0 0 75px; color: #555; }
      .nl-slider-row input[type=range] { flex: 1; cursor: pointer; accent-color: #0a7cff; }
      .nl-slider-row .nl-val { flex: 0 0 32px; text-align: right; font-weight: 600; color: #0a7cff; }
      .nl-toggle-row { display: flex; align-items: center; justify-content: space-between; font-size: 12px; }
      .nl-toggle { position: relative; width: 34px; height: 18px; display: inline-block; cursor: pointer; }
      .nl-toggle input { opacity: 0; width: 0; height: 0; }
      .nl-track { position: absolute; inset: 0; background: #ccc; border-radius: 20px; transition: 0.2s; }
      .nl-track::after {
        content: ''; position: absolute; left: 2px; top: 2px;
        width: 14px; height: 14px; background: #fff; border-radius: 50%; transition: 0.2s;
      }
      .nl-toggle input:checked + .nl-track { background: #0a7cff; }
      .nl-toggle input:checked + .nl-track::after { transform: translateX(16px); }
      .nl-divider { height: 1px; background: #ececec; margin: 2px 0; }
      #nl-shortcuts { font-size: 10px; color: #aaa; text-align: center; margin-top: 1px; }
    `;

    function build() {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);

      el = document.createElement('div');
      el.id = 'nl-panel';
      el.innerHTML = `
        <div id="nl-card">
          <div id="nl-header" class="${collapsed ? 'collapsed' : ''}">
            <div style="display:flex;align-items:center;">
              <span id="nl-title">📖 NodeLoc 漫游助手</span>
              <span id="nl-badge">v20 完整日志复制版</span>
            </div>
            <button id="nl-toggle-collapse">${collapsed ? '▲' : '▼'}</button>
          </div>
          <div id="nl-body" style="${collapsed ? 'display:none' : ''}">

            <div id="nl-status">等待进入帖子...</div>

            <!-- 已读统计 -->
            <div class="nl-stats-bar">
              <span>已读记录: <b id="nl-read-count" style="color:#0a7cff">${HistoryManager.count()}</b> / 200 篇</span>
              <a class="nl-clear-link" id="nl-clear-btn">清空</a>
            </div>

            <div class="nl-divider"></div>

            <!-- 核心交互：有依据的 AI 回复候选 -->
            <div id="nl-manual-ai-box">
              <div class="nl-ai-header">
                <span>🤖 有依据的回复候选</span>
                <div class="nl-ai-actions">
                  <button class="nl-link-button" id="nl-view-logs" type="button" title="查看请求日志">📋 日志</button>
                  <a class="nl-clear-link" id="nl-toggle-ai-cfg" style="font-size:11px; font-weight:normal;">
                    ${CFG.showAiCfg ? '收起配置 ▲' : '⚙️ API 配置 ▼'}
                  </a>
                </div>
              </div>

              <!-- API 配置折叠框 -->
              <div id="nl-ai-cfg-box" class="nl-ai-cfg-box ${!CFG.showAiCfg ? 'hidden' : ''}">
                <div class="nl-input-row">
                  <label style="color:#666">快捷导入 NewAPI JSON:</label>
                  <input type="text" id="nl-ai-json-import" placeholder='粘贴 {"key":"sk-...","url":"..."}'>
                </div>
                <div class="nl-input-row">
                  <div style="display:flex;gap:4px;">
                    <select id="nl-ai-format" style="flex:1">
                      <option value="anthropic" ${CFG.apiFormat==='anthropic'?'selected':''}>Anthropic 格式</option>
                      <option value="openai" ${CFG.apiFormat==='openai'?'selected':''}>OpenAI 格式</option>
                    </select>
                    <input type="text" id="nl-ai-model" value="${CFG.modelName}" placeholder="模型名 如 claude-opus-4-8" style="flex:1">
                  </div>
                </div>
                <div class="nl-input-row">
                  <input type="text" id="nl-ai-url" value="${CFG.apiUrl}" placeholder="Base URL 如 https://tabitoken.com">
                </div>
                <div class="nl-input-row">
                  <input type="password" id="nl-ai-key" value="${CFG.apiKey}" placeholder="API Key (sk-...)">
                </div>
              </div>

              <!-- 请求日志区 -->
              <div id="nl-log-box" class="hidden">
                <div class="nl-log-head">
                  <span style="font-weight:600">最近 10 次调用日志</span>
                  <div style="display:flex; gap:8px;">
                    <button class="nl-link-button" id="nl-copy-latest-log" type="button" title="一键复制最新完整日志">📋 复制最新</button>
                    <button class="nl-link-button" id="nl-clear-logs" type="button">清空</button>
                  </div>
                </div>
                <div id="nl-log-list"></div>
              </div>

              <!-- 候选选择、预览与编辑框 -->
              <div id="nl-candidate-list" class="hidden"></div>
              <textarea id="nl-reply-textarea" placeholder="点击生成后点选候选，也可在此自由输入或修改回复..."></textarea>

              <!-- 核心按钮 -->
              <div class="nl-btn-row">
                <button class="nl-btn generate" id="nl-generate-btn">💡 生成本帖回复</button>
                <button class="nl-btn confirm" id="nl-send-btn" disabled>🚀 确认回复</button>
              </div>
            </div>

            <div class="nl-divider"></div>

            <!-- 滚动模式切换 -->
            <div class="nl-mode-group">
              <button class="nl-mode-btn ${CFG.mode==='uniform'?'active':''}" data-mode="uniform">🎯 匀速</button>
              <button class="nl-mode-btn ${CFG.mode==='random'?'active':''}" data-mode="random">🎲 随机防检测</button>
            </div>

            <div id="nl-uniform-section" class="${CFG.mode!=='uniform'?'hidden':''}">
              <div class="nl-slider-row">
                <label>匀速速度</label>
                <input type="range" id="nl-uniform-spd" min="1" max="8" step="1" value="${CFG.uniformSpeed}">
                <span class="nl-val" id="nl-uniform-spd-val">${CFG.uniformSpeed}</span>
              </div>
            </div>

            <div id="nl-rand-section" class="${CFG.mode!=='random'?'hidden':''}">
              <div class="nl-slider-row">
                <label>速度区间</label>
                <input type="range" id="nl-rand-max" min="2" max="8" step="1" value="${CFG.randomSpeedMax}">
                <span class="nl-val" id="nl-rand-max-val">${CFG.randomSpeedMin}~${CFG.randomSpeedMax}</span>
              </div>
              <div class="nl-slider-row">
                <label>停顿概率</label>
                <input type="range" id="nl-pause-chance" min="0" max="12" step="1" value="${CFG.pauseChance}">
                <span class="nl-val" id="nl-pause-chance-val">${CFG.pauseChance}%</span>
              </div>
            </div>

            <!-- 漫游控制 -->
            <div class="nl-toggle-row">
              <span>自动跳转下一篇</span>
              <label class="nl-toggle">
                <input type="checkbox" id="nl-auto-next" ${CFG.autoNext?'checked':''}>
                <span class="nl-track"></span>
              </label>
            </div>
            <div class="nl-slider-row">
              <label>触底等待</label>
              <input type="range" id="nl-bottom-wait" min="500" max="5000" step="500" value="${CFG.bottomWait}">
              <span class="nl-val" id="nl-bottom-wait-val">${(CFG.bottomWait/1000).toFixed(1)}s</span>
            </div>

            <div class="nl-btn-row">
              <button class="nl-btn primary" id="nl-pause-btn">⏸ 暂停</button>
              <button class="nl-btn secondary" id="nl-skip-btn">⏭ 下一篇</button>
            </div>

            <div id="nl-shortcuts">快捷键：P 暂停/恢复 · S 跳过</div>
          </div>
        </div>
      `;
      document.body.appendChild(el);

      statusEl       = el.querySelector('#nl-status');
      statsEl        = el.querySelector('#nl-read-count');
      replyTextarea  = el.querySelector('#nl-reply-textarea');
      candidateList  = el.querySelector('#nl-candidate-list');
      sendBtn        = el.querySelector('#nl-send-btn');
      logBox         = el.querySelector('#nl-log-box');
      logList        = el.querySelector('#nl-log-list');

      // 折叠面板
      el.querySelector('#nl-header').addEventListener('click', () => {
        collapsed = !collapsed;
        CFG.panelCollapsed = collapsed;
        el.querySelector('#nl-body').style.display = collapsed ? 'none' : '';
        el.querySelector('#nl-toggle-collapse').textContent = collapsed ? '▲' : '▼';
        el.querySelector('#nl-header').className = collapsed ? 'collapsed' : '';
      });
      el.querySelector('#nl-body').addEventListener('click', e => e.stopPropagation());

      // 清空已读
      el.querySelector('#nl-clear-btn').addEventListener('click', () => HistoryManager.clear());

      // API 配置折叠展开
      const aiCfgBox = el.querySelector('#nl-ai-cfg-box');
      const toggleAiCfgBtn = el.querySelector('#nl-toggle-ai-cfg');
      toggleAiCfgBtn.addEventListener('click', () => {
        CFG.showAiCfg = !CFG.showAiCfg;
        aiCfgBox.className = `nl-ai-cfg-box ${!CFG.showAiCfg ? 'hidden' : ''}`;
        toggleAiCfgBtn.textContent = CFG.showAiCfg ? '收起配置 ▲' : '⚙️ API 配置 ▼';
      });

      // 生成未截断的完整日志字符串（包含所有提示词、模型原始输出与 JSON 数据）
      function getFullLogExport(entry) {
        const req = entry.request || {};
        const res = entry.result || {};
        return [
          `==================================================`,
          `【NodeLoc AI 请求完整日志】`,
          `请求时间: ${entry.createdAt || '未知'}`,
          `请求 ID: ${entry.id || '未知'}`,
          `帖子标题: ${req.title || '（未知）'}`,
          `调用模型: ${req.model || '未知'} (${req.format || 'anthropic'})`,
          `请求状态: ${res.status || 'pending'}`,
          `==================================================\n`,
          `【1. 完整系统提示词 (System Prompt)】:`,
          req.systemPrompt || '（无）',
          `\n【2. 完整用户提示词 (User Prompt)】:`,
          req.userPrompt || '（无）',
          `\n【3. 模型原始返回 (Raw Model Reply)】:`,
          res.rawReply || '（无）',
          `\n【4. 解析与候选提取】:`,
          `- 解析模式: ${res.parseMode || '未知'}`,
          `- 模型返回候选列表: ${JSON.stringify(res.rawCandidates || [], null, 2)}`,
          `- 本地校验通过列表: ${JSON.stringify(res.validCandidates || [], null, 2)}`,
          `- 错误信息: ${res.error || '无'}`,
          `\n【5. 完整底层数据对象 (Raw JSON Dump)】:`,
          JSON.stringify(entry, null, 2),
          `\n==================================================`
        ].join('\n');
      }

      function formatRequestLog(entry) {
        const req = entry.request || {};
        const res = entry.result || { status: 'pending' };
        return [
          `【系统提示词】\n${req.systemPrompt || '（无）'}`,
          `【用户提示词】\n${req.userPrompt || '（无）'}`,
          `【模型返回】\n${res.rawReply || '（尚未返回）'}`,
          `【校验结果】\n${JSON.stringify({
            status: res.status,
            validCandidates: res.validCandidates,
            parseMode: res.parseMode,
            error: res.error
          }, null, 2)}`
        ].join('\n\n');
      }

      // 渲染日志列表（带单条复制按钮）
      function renderRequestLogs() {
        if (!logList) return;
        const savedLogs = RequestLog.getAll().slice().reverse();
        logList.replaceChildren();
        if (savedLogs.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'nl-log-empty';
          empty.textContent = '暂无请求日志';
          logList.appendChild(empty);
          return;
        }
        savedLogs.forEach((entry, index) => {
          const logItem = document.createElement('details');
          logItem.className = 'nl-log-item';
          logItem.open = index === 0;

          const headerDiv = document.createElement('div');
          headerDiv.className = 'nl-log-item-header';

          const logSummary = document.createElement('summary');
          const status = entry.result && entry.result.status ? entry.result.status : 'pending';
          logSummary.textContent = `${entry.createdAt || '未知时间'} · ${status}`;

          // 右上角单条悬浮/常驻复制按钮
          const copyBtn = document.createElement('button');
          copyBtn.type = 'button';
          copyBtn.className = 'nl-log-copy-btn';
          copyBtn.textContent = '📋 复制完整';
          copyBtn.title = '复制本次请求的全部无截断提示词与模型返回';
          copyBtn.addEventListener('click', async e => {
            e.preventDefault();
            e.stopPropagation();
            try {
              await copyToClipboard(getFullLogExport(entry));
              copyBtn.textContent = '✅ 已复制!';
              setTimeout(() => { copyBtn.textContent = '📋 复制完整'; }, 1800);
            } catch (err) {
              copyBtn.textContent = '❌ 复制失败';
            }
          });

          headerDiv.append(logSummary, copyBtn);

          const logContent = document.createElement('pre');
          logContent.className = 'nl-log-content';
          logContent.textContent = formatRequestLog(entry);

          logItem.append(headerDiv, logContent);
          logList.appendChild(logItem);
        });
      }

      const viewLogsBtn = el.querySelector('#nl-view-logs');
      viewLogsBtn.addEventListener('click', () => {
        logBox.classList.toggle('hidden');
        if (!logBox.classList.contains('hidden')) renderRequestLogs();
      });

      // 顶部一键复制最新日志按钮
      el.querySelector('#nl-copy-latest-log').addEventListener('click', async e => {
        const savedLogs = RequestLog.getAll();
        if (savedLogs.length === 0) {
          setStatus('暂无日志可复制', true);
          return;
        }
        const latestEntry = savedLogs[savedLogs.length - 1];
        const btn = e.target;
        try {
          await copyToClipboard(getFullLogExport(latestEntry));
          btn.textContent = '✅ 已复制最新!';
          setTimeout(() => { btn.textContent = '📋 复制最新'; }, 1800);
        } catch (err) {
          btn.textContent = '❌ 失败';
        }
      });

      el.querySelector('#nl-clear-logs').addEventListener('click', () => {
        RequestLog.clear();
        renderRequestLogs();
      });

      // JSON 导入
      const jsonImportInput = el.querySelector('#nl-ai-json-import');
      jsonImportInput.addEventListener('input', e => {
        const val = e.target.value.trim();
        try {
          const parsed = JSON.parse(val);
          if (parsed.key) { CFG.apiKey = parsed.key; el.querySelector('#nl-ai-key').value = parsed.key; }
          if (parsed.url) { CFG.apiUrl = parsed.url; el.querySelector('#nl-ai-url').value = parsed.url; }
          if (parsed.format) { CFG.apiFormat = parsed.format; el.querySelector('#nl-ai-format').value = parsed.format; }
          jsonImportInput.value = '✅ 导入配置成功！';
          setTimeout(() => { jsonImportInput.value = ''; }, 2000);
        } catch (err) {}
      });

      el.querySelector('#nl-ai-format').addEventListener('change', e => { CFG.apiFormat = e.target.value; });
      el.querySelector('#nl-ai-model').addEventListener('input', e => { CFG.modelName = e.target.value.trim(); });
      el.querySelector('#nl-ai-url').addEventListener('input', e => { CFG.apiUrl = e.target.value.trim(); });
      el.querySelector('#nl-ai-key').addEventListener('input', e => { CFG.apiKey = e.target.value.trim(); });

      function resetReplyCandidates() {
        replyTextarea.value = '';
        candidateList.replaceChildren();
        candidateList.classList.add('hidden');
        sendBtn.disabled = true;
      }

      function renderReplyCandidates(candidates, parseMode) {
        candidateList.replaceChildren();
        candidateList.classList.remove('hidden');

        const title = document.createElement('div');
        title.className = 'nl-candidate-title';
        title.textContent = `点击直接选用候选（${parseMode === 'line_fallback' ? '逐行恢复' : '智能生成'}）：`;
        candidateList.appendChild(title);

        candidates.forEach((cand, idx) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'nl-candidate';
          btn.textContent = `${idx + 1}. ${cand}`;
          btn.addEventListener('click', () => {
            replyTextarea.value = cand;
            candidateList.querySelectorAll('.nl-candidate').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            sendBtn.disabled = false;
            setStatus('已选择候选，可直接确认或在上方微调', true);
          });
          candidateList.appendChild(btn);
        });
      }

      function renderCandidateNotice(msg) {
        candidateList.replaceChildren();
        candidateList.classList.remove('hidden');
        const notice = document.createElement('div');
        notice.className = 'nl-candidate-notice';
        notice.textContent = msg;
        candidateList.appendChild(notice);
      }

      replyTextarea.addEventListener('input', () => {
        const text = replyTextarea.value.trim();
        sendBtn.disabled = text.length === 0;
      });

      // 【核心按钮 1】：生成本帖回复
      const genBtn = el.querySelector('#nl-generate-btn');
      genBtn.addEventListener('click', async () => {
        if (!isTopicPage()) {
          setStatus('请先进入具体的文章帖子页面');
          return;
        }

        // 生成时自动暂停漫游，防止切帖
        if (scroller.active && !scroller.paused) {
          scroller.togglePause();
          updatePauseBtn();
        }

        resetReplyCandidates();
        genBtn.disabled = true;
        genBtn.textContent = '⏳ 正在研读全帖...';
        setStatus('🤖 正在分析主楼图文与楼下多层讨论...', true);

        try {
          const result = await AIReplyEngine.generateReply();
          if (result.rawCandidates.length === 0) {
            renderCandidateNotice('模型有返回但未解析出候选，请点击右上角「📋 日志」查看详情');
            setStatus('未识别出有效候选，可在日志中查看', true);
            genBtn.textContent = '🔄 换一组';
            return;
          }

          renderReplyCandidates(result.validCandidates.length > 0 ? result.validCandidates : result.rawCandidates, result.parseMode);
          genBtn.textContent = '🔄 换一组';
          setStatus(`已生成 ${result.rawCandidates.length} 条候选，点击选用后即可发送`, true);
        } catch (err) {
          renderCandidateNotice(`生成失败: ${err.message}`);
          setStatus(`生成失败: ${err.message}`, true);
          genBtn.textContent = '💡 生成本帖回复';
        } finally {
          genBtn.disabled = false;
        }
      });

      // 【核心按钮 2】：确认回复
      sendBtn.addEventListener('click', async () => {
        const text = replyTextarea.value.trim();
        if (!text) {
          setStatus('回复内容不能为空');
          return;
        }
        sendBtn.disabled = true;
        sendBtn.textContent = '🚀 发送中...';
        setStatus('正在发表回复...', true);

        try {
          await AIReplyEngine.submitReply(text);
          setStatus(`🎉 回复成功: "${text.slice(0, 16)}..."`, true);
          resetReplyCandidates();
          genBtn.textContent = '💡 生成本帖回复';
        } catch (err) {
          setStatus(`发送失败: ${err.message}`, true);
          sendBtn.disabled = false;
        } finally {
          sendBtn.textContent = '🚀 确认回复';
        }
      });

      // 模式切换
      el.querySelectorAll('.nl-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const mode = btn.dataset.mode;
          CFG.mode = mode;
          el.querySelectorAll('.nl-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
          el.querySelector('#nl-uniform-section').className = mode !== 'uniform' ? 'hidden' : '';
          el.querySelector('#nl-rand-section').className    = mode !== 'random'  ? 'hidden' : '';
        });
      });

      bindSlider('#nl-uniform-spd', '#nl-uniform-spd-val', v => { CFG.uniformSpeed = v; return v; });
      bindSlider('#nl-rand-max', '#nl-rand-max-val', v => {
        CFG.randomSpeedMax = v;
        return `${CFG.randomSpeedMin}~${v}`;
      });
      bindSlider('#nl-pause-chance', '#nl-pause-chance-val', v => { CFG.pauseChance = v; return v + '%'; });
      bindSlider('#nl-bottom-wait', '#nl-bottom-wait-val', v => { CFG.bottomWait = v; return (v/1000).toFixed(1) + 's'; });

      el.querySelector('#nl-auto-next').addEventListener('change', e => { CFG.autoNext = e.target.checked; });

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
        if (url) { window.location.href = url; }
        else { panel.setStatus('未找到下一篇'); }
      });
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
      if (!replyStatusPinned) setStatus(txt);
    }

    function updateStats() {
      if (!statsEl && el) statsEl = el.querySelector('#nl-read-count');
      if (statsEl) statsEl.textContent = HistoryManager.count();
    }

    function updatePauseBtn() {
      const btn = el && el.querySelector('#nl-pause-btn');
      if (!btn) return;
      if (!scroller.active) {
        btn.textContent = '▶ 开始'; btn.className = 'nl-btn primary';
      } else if (scroller.paused) {
        btn.textContent = '▶ 恢复'; btn.className = 'nl-btn primary';
      } else {
        btn.textContent = '⏸ 暂停'; btn.className = 'nl-btn danger';
      }
    }

    return { build, setStatus, setActivityStatus, updateStats, updatePauseBtn };
  })();

  // ============================================================
  // AutoScroller 实例与 SPA 监听
  // ============================================================
  const scroller = new AutoScroller();
  let currentPath = window.location.pathname;

  function handleRouteChange() {
    const np = window.location.pathname;
    if (np === currentPath) return;
    currentPath = np;
    log('路由变化 →', np);
    scroller.stop();
    panel.updatePauseBtn();
    if (isTopicPage()) {
      panel.setStatus('页面加载中...');
      WorkerTimer.setTimeout(() => { scroller.start(); panel.updatePauseBtn(); }, 1000);
    } else {
      panel.setStatus('请点击帖子进入阅读');
    }
  }

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

  // 快捷键
  document.addEventListener('keydown', e => {
    if (['INPUT','TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable) return;
    if (e.key === 'p' || e.key === 'P') {
      scroller.togglePause();
      panel.updatePauseBtn();
    }
    if (e.key === 's' || e.key === 'S') {
      scroller.stop();
      getNextTopicUrl().then(url => { if (url) window.location.href = url; });
    }
  });

  // 初始化
  function init() {
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
