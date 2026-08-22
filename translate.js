/**
 * Windhawk mod 介绍自动翻译 (translate.js)
 * ------------------------------------------------------------
 * 注入到 Windhawk 桌面客户端 (VSCodium webview) 的翻译脚本：
 *  - 自动翻译 mod 详情页 README 长文介绍 + mod 卡片短描述（英文 → 简体中文）
 *  - 多翻译后端自动降级：Google gtx → Bing → MyMemory
 *  - 本地缓存译文 (localStorage)，翻过一次不再重复请求
 *  - 右下角浮动按钮开关，状态记忆
 *  - 全部逻辑失败静默，绝不影响 Windhawk 原有功能
 */
(function () {
  'use strict';

  // ==================== 配置 ====================
  var TARGET_LANG = 'zh-CN';            // 目标语言 (Google/MyMemory 用)
  var BING_TO = 'zh-Hans';              // Bing 用
  var MAX_CONCURRENCY = 4;              // 同时请求数
  var CACHE_KEY = 'wh-translate-cache-v2';       // v2: 校验缓存有效性
  var SETTING_KEY = 'wh-translate-enabled';

  var README_SELECTOR = '[class*="ReactMarkdownCustom__ReactMarkdownStyleWrapper"]';
  var DESC_SELECTOR = '[class*="ant-card-meta-description"]';
  // 详情页/卡片的 mod 名称标题（元数据无中文时保持英文，需要翻译）
  var TITLE_SELECTOR = '[class*="ModDetailsHeader__CardTitleFirstLine"], [class*="ModCard__ModCardTitle"]';
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';

  // ==================== 工具 ====================
  function hasCJK(s) {
    return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(s);
  }

  /** 判断文本是否值得翻译 */
  function worthTranslating(s) {
    s = (s || '').trim();
    if (!s || s.length < 4 || s.length > 3000) return false;
    if (hasCJK(s)) return false;                      // 已是中文
    if (/^[\d\s\W_]+$/.test(s)) return false;         // 纯数字/符号
    if (/^[a-z0-9][a-z0-9\-_.]*$/i.test(s)) return false; // 标识符/版本号/文件名
    if (/https?:\/\/\S+/.test(s) && s.indexOf(' ') < 0) return false; // 纯URL
    if (/[{};=<>]/.test(s) && !/[a-zA-Z]{4,}/.test(s)) return false; // 代码片段
    var words = s.match(/[A-Za-z]{2,}/g);
    if (!words || words.length < 2) return false;     // 至少2个英文单词
    return true;
  }

  function hash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return 'h' + (h >>> 0).toString(36);
  }

  // ==================== 缓存 ====================
  var cache = {};
  var cacheOk = false;
  try {
    cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {};
    cacheOk = true;
  } catch (e) { /* localStorage 不可用时用内存缓存 */ }

  function getCached(text) {
    var k = hash(text);
    var v = cache[k];
    // 校验缓存有效性：译文必须含汉字，坏缓存（错误响应等）直接忽略
    return (v !== undefined && hasCJK(v)) ? v : null;
  }
  function setCached(text, translated) {
    if (!translated || translated === text) return;
    var k = hash(text);
    cache[k] = translated;
    if (cacheOk) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { cacheOk = false; }
    }
  }

  // ==================== 翻译后端 ====================
  var backendOrder = ['google', 'bing', 'mymemory']; // 按顺序尝试
  var backendState = {}; // google/bing/mymemory: 'ok' | 'bad'

  function markBackend(name, ok) {
    backendState[name] = ok ? 'ok' : 'bad';
  }

  /** 带超时的 fetch（防止网络挂起卡死 busy 标志） */
  function fetchWithTimeout(url, opts, ms) {
    var timeout = ms || 6000;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    if (ctrl) {
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* ignore */ } }, timeout);
    }
    var o = Object.assign({}, opts || {});
    if (ctrl) o.signal = ctrl.signal;
    return fetch(url, o).finally(function () {
      if (timer) clearTimeout(timer);
    });
  }

  /** Google 免费接口 (client=gtx) */
  async function translateGoogle(text) {
    var url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=' + TARGET_LANG + '&dt=t&q=' + encodeURIComponent(text);
    var r = await fetchWithTimeout(url);
    if (!r.ok) throw new Error('google ' + r.status);
    var j = await r.json();
    if (!j || !Array.isArray(j[0])) throw new Error('google bad json');
    return j[0].map(function (x) { return x && x[0] ? x[0] : ''; }).join('');
  }

  /** Bing 网页翻译接口 (ttranslatev3) */
  async function translateBing(texts) {
    // 获取页面参数 IG + AbusePreventionHelper key
    var page = await (await fetchWithTimeout('https://cn.bing.com/translator', {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    })).text();
    var igM = page.match(/IG:"([a-fA-F0-9]{20,})"/);
    var keyM = page.match(/params_AbusePreventionHelper\s*=\s*\[[^\]]*?,\s*"([^"]+)"/);
    if (!igM || !keyM) throw new Error('bing params');
    var url = 'https://cn.bing.com/ttranslatev3?isMultilingual=true&from=en&to=' + BING_TO + '&IG=' + igM[1] + '&key=' + keyM[1];
    var r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'Referer': 'https://cn.bing.com/translator' },
      body: JSON.stringify(texts.map(function (t) { return { Text: t }; })),
    });
    if (!r.ok) throw new Error('bing ' + r.status);
    var j = await r.json();
    return texts.map(function (t, i) {
      var seg = j && j[i] && j[i].translations;
      return seg && seg[0] && seg[0].text ? seg[0].text : t;
    });
  }

  /** MyMemory 免费接口 */
  async function translateMyMemory(text) {
    var url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en|zh-CN';
    var r = await fetchWithTimeout(url);
    if (!r.ok) throw new Error('mymemory ' + r.status);
    var j = await r.json();
    var t = j && j.responseData && j.responseData.translatedText;
    if (!t) throw new Error('mymemory empty');
    return t;
  }

  /** 判断译文是否有效（翻译成中文必须含汉字，防止错误响应/原文回显被应用） */
  function isGoodTranslation(tr, orig) {
    if (!tr || !tr.trim()) return false;
    if (tr === orig) return false;
    if (tr.length > 3000) return false;
    return hasCJK(tr);
  }

  /** 并发映射（单条失败不拖垮整批；failFast: 失败数超阈值提前放弃） */
  async function mapWithConcurrency(arr, limit, fn, failFast) {
    var results = new Array(arr.length);
    var idx = 0;
    var fails = 0;
    var stopped = false;
    async function worker() {
      while (idx < arr.length && !stopped) {
        var i = idx++;
        try {
          results[i] = await fn(arr[i], i);
        } catch (e) {
          results[i] = null;
          fails++;
          if (failFast && fails >= failFast) stopped = true;
        }
      }
    }
    var workers = [];
    for (var w = 0; w < Math.min(limit, arr.length); w++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  /** 翻译一批文本；返回 Map<原文本, 译文>，失败的后端降级 */
  async function translateBatch(texts) {
    var results = {};
    // 先填缓存
    for (var ci = 0; ci < texts.length; ci++) {
      var cv = getCached(texts[ci]);
      if (cv) results[texts[ci]] = cv;
    }
    var need = texts.filter(function (x) { return results[x] === undefined; });
    if (!need.length) return results;

    // 后端1: Google（并发，连续3条失败则快速放弃）
    if (backendState['google'] !== 'bad') {
      var googleOut = [];
      try {
        googleOut = await mapWithConcurrency(need, MAX_CONCURRENCY, function (t) {
          var c = getCached(t);
          return c ? Promise.resolve(c) : translateGoogle(t);
        }, 3);
      } catch (e) {
        markBackend('google', false);
      }
      var googleFails = 0;
      for (var i = 0; i < need.length; i++) {
        if (googleOut[i] === null) googleFails++;
        else if (isGoodTranslation(googleOut[i], need[i])) { results[need[i]] = googleOut[i]; setCached(need[i], googleOut[i]); }
      }
      if (googleFails > need.length / 2) markBackend('google', false);
    }

    var rest = texts.filter(function (x) { return results[x] === undefined; });
    if (rest.length) {
      try {
        var arr = await translateBing(rest);
        for (var j = 0; j < rest.length; j++) {
          if (isGoodTranslation(arr[j], rest[j])) {
            results[rest[j]] = arr[j];
            setCached(rest[j], arr[j]);
          }
        }
      } catch (e) {
        markBackend('bing', false);
      }
    }

    rest = texts.filter(function (x) { return results[x] === undefined; });
    if (rest.length) {
      var mmOut = await mapWithConcurrency(rest, 2, translateMyMemory);
      for (var k = 0; k < rest.length; k++) {
        if (isGoodTranslation(mmOut[k], rest[k])) { results[rest[k]] = mmOut[k]; setCached(rest[k], mmOut[k]); }
      }
    }
    return results;
  }

  // ==================== DOM 扫描与翻译 ====================
  var processedNodes = new WeakSet();
  var busy = false;
  var scanTimer = null;

  function isSkippable(el) {
    if (!el) return true;
    var tag = el.tagName;
    if (tag === 'PRE' || tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' ||
        tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'MATH' ||
        tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' ||
        tag === 'AUDIO' || tag === 'VIDEO' || tag === 'IFRAME' || tag === 'CANVAS') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  /** 收集 README 容器内所有可翻译的文本节点 */
  function collectReadmeTexts(root) {
    var items = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      if (!parent) continue;
      if (isSkippable(parent)) continue;
      var text = node.textContent || '';
      if (!worthTranslating(text)) continue;
      if (processedNodes.has(node)) continue;
      items.push({ node: node, text: text.trim() });
    }
    return items;
  }

  /** 收集卡片/详情描述元素文本 */
  function collectDescs(root) {
    var items = [];
    var els = root.querySelectorAll(DESC_SELECTOR);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.dataset && el.dataset.whTr) continue;
      if (isSkippable(el)) continue;
      var text = (el.textContent || '').trim();
      if (!worthTranslating(text)) continue;
      items.push({ el: el, text: text });
    }
    return items;
  }

  function applyResults(items, results) {
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var tr = results[it.text];
      if (!tr) continue;
      if (it.node) {
        it.node.textContent = tr;
        processedNodes.add(it.node);
      } else if (it.el) {
        it.el.textContent = tr;
        if (it.el.dataset) it.el.dataset.whTr = '1';
      }
    }
  }

  function scan() {
    if (busy || !isEnabled()) return;
    var items = [];
    // 1) README 长文介绍容器
    var targets = document.querySelectorAll(README_SELECTOR);
    for (var i = 0; i < targets.length; i++) {
      items = items.concat(collectReadmeTexts(targets[i]));
    }
    // 2) mod 名称标题（详情页标题栏 / 卡片标题）
    var titles = document.querySelectorAll(TITLE_SELECTOR);
    for (var j = 0; j < titles.length; j++) {
      items = items.concat(collectReadmeTexts(titles[j]));
    }
    // 3) 卡片/详情短描述
    items = items.concat(collectDescs(document));
    if (!items.length) return;
    var texts = [];
    var seen = {};
    for (var j = 0; j < items.length; j++) {
      if (!seen[items[j].text]) { seen[items[j].text] = 1; texts.push(items[j].text); }
    }
    busy = true;
    translateBatch(texts)
      .then(function (results) { applyResults(items, results); })
      .catch(function () { /* 静默 */ })
      .finally(function () { busy = false; });
  }

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 900);
  }

  // ==================== 开关 ====================
  function isEnabled() {
    var v = null;
    try { v = localStorage.getItem(SETTING_KEY); } catch (e) { /* ignore */ }
    return v !== '0';
  }

  var toggleBtn = null;
  function ensureToggleButton() {
    if (toggleBtn && toggleBtn.isConnected) return;
    toggleBtn = document.createElement('button');
    toggleBtn.id = 'wh-translate-toggle';
    toggleBtn.textContent = '🌐 译';
    toggleBtn.title = 'Mod 介绍自动翻译（点击开关）';
    toggleBtn.style.cssText =
      'position:fixed;right:14px;bottom:14px;z-index:2147483646;' +
      'background:rgba(0,120,212,.92);color:#fff;border:none;border-radius:14px;' +
      'padding:5px 12px;font-size:12px;font-family:Segoe UI,Microsoft YaHei,sans-serif;' +
      'cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);opacity:.55;' +
      'transition:opacity .2s;';
    toggleBtn.onmouseenter = function () { toggleBtn.style.opacity = '1'; };
    toggleBtn.onmouseleave = function () { toggleBtn.style.opacity = '.55'; };
    toggleBtn.onclick = function () {
      var now = isEnabled();
      try { localStorage.setItem(SETTING_KEY, now ? '0' : '1'); } catch (e) { /* ignore */ }
      if (now) {
        // 关闭：把译文恢复为原文（从缓存反向？无法可靠还原，改为刷新页面文案提示）
        toggleBtn.textContent = '🌐 译';
        toggleBtn.style.background = 'rgba(120,120,120,.92)';
      } else {
        toggleBtn.textContent = '🌐 译';
        toggleBtn.style.background = 'rgba(0,120,212,.92)';
        scheduleScan();
      }
    };
    if (!isEnabled()) toggleBtn.style.background = 'rgba(120,120,120,.92)';
    document.body.appendChild(toggleBtn);
  }

  // ==================== 启动 ====================
  var lastScanCall = 0;
  function scheduleScan() {
    var now = Date.now();
    if (now - lastScanCall < 1500) return; // 节流
    lastScanCall = now;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 900);
  }

  function init() {
    ensureToggleButton();
    scheduleScan();
    // 监听 DOM 变化（Angular/React 渲染、页面切换）
    var mo = new MutationObserver(function () {
      ensureToggleButton();
      scheduleScan();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    // 兜底轮询（每 4 秒一次，防止遗漏）
    setInterval(function () { ensureToggleButton(); scheduleScan(); }, 4000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
