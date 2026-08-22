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
  var CFG_KEY = 'wh-translate-config-v1';        // 翻译设置（后端选择 + API 配置）

  // 默认设置
  var DEFAULT_CONFIG = {
    backend: 'auto',        // auto | google | bing | mymemory | baidu | ai
    baidu: { appid: '', key: '' },
    ai: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' },
  };

  var settings = loadConfig();

  function loadConfig() {
    var cfg = {};
    try { cfg = JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; } catch (e) { cfg = {}; }
    // 合并默认值
    return {
      backend: cfg.backend || DEFAULT_CONFIG.backend,
      baidu: {
        appid: (cfg.baidu && cfg.baidu.appid) || DEFAULT_CONFIG.baidu.appid,
        key: (cfg.baidu && cfg.baidu.key) || DEFAULT_CONFIG.baidu.key,
      },
      ai: {
        baseUrl: (cfg.ai && cfg.ai.baseUrl) || DEFAULT_CONFIG.ai.baseUrl,
        apiKey: (cfg.ai && cfg.ai.apiKey) || DEFAULT_CONFIG.ai.apiKey,
        model: (cfg.ai && cfg.ai.model) || DEFAULT_CONFIG.ai.model,
      },
    };
  }

  function saveConfig() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

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
  var backendState = {}; // google/bing/mymemory/baidu/ai: 'ok' | 'bad'

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

  // ---- MD5（百度翻译签名用，标准实现） ----
  var md5 = (function () {
    function safeAdd(x, y) { var lsw = (x & 0xffff) + (y & 0xffff), msw = (x >> 16) + (y >> 16) + (lsw >> 16); return (msw << 16) | (lsw & 0xffff); }
    function bitRotateLeft(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
    function md5cmn(q, a, b, x, s, t) { return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
    function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | (~b & d), a, b, x, s, t); }
    function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
    function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }
    function binlMD5(x, len) {
      x[len >> 5] |= 0x80 << (len % 32); x[(((len + 64) >>> 9) << 4) + 14] = len;
      var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
      for (var i = 0; i < x.length; i += 16) {
        var olda = a, oldb = b, oldc = c, oldd = d;
        a = md5ff(a, b, c, d, x[i], 7, -680876936); d = md5ff(d, a, b, c, x[i + 1], 12, -389564586); c = md5ff(c, d, a, b, x[i + 2], 17, 606105819); b = md5ff(b, c, d, a, x[i + 3], 22, -1044525330);
        a = md5ff(a, b, c, d, x[i + 4], 7, -176418897); d = md5ff(d, a, b, c, x[i + 5], 12, 1200080426); c = md5ff(c, d, a, b, x[i + 6], 17, -1473231341); b = md5ff(b, c, d, a, x[i + 7], 22, -45705983);
        a = md5ff(a, b, c, d, x[i + 8], 7, 1770035416); d = md5ff(d, a, b, c, x[i + 9], 12, -1958414417); c = md5ff(c, d, a, b, x[i + 10], 17, -42063); b = md5ff(b, c, d, a, x[i + 11], 22, -1990404162);
        a = md5ff(a, b, c, d, x[i + 12], 7, 1804603682); d = md5ff(d, a, b, c, x[i + 13], 12, -40341101); c = md5ff(c, d, a, b, x[i + 14], 17, -1502002290); b = md5ff(b, c, d, a, x[i + 15], 22, 1236535329);
        a = md5gg(a, b, c, d, x[i + 1], 5, -165796510); d = md5gg(d, a, b, c, x[i + 6], 9, -1069501632); c = md5gg(c, d, a, b, x[i + 11], 14, 643717713); b = md5gg(b, c, d, a, x[i], 20, -373897302);
        a = md5gg(a, b, c, d, x[i + 5], 5, -701558691); d = md5gg(d, a, b, c, x[i + 10], 9, 38016083); c = md5gg(c, d, a, b, x[i + 15], 14, -660478335); b = md5gg(b, c, d, a, x[i + 4], 20, -405537848);
        a = md5gg(a, b, c, d, x[i + 9], 5, 568446438); d = md5gg(d, a, b, c, x[i + 14], 9, -1019803690); c = md5gg(c, d, a, b, x[i + 3], 14, -187363961); b = md5gg(b, c, d, a, x[i + 8], 20, 1163531501);
        a = md5gg(a, b, c, d, x[i + 13], 5, -1444681467); d = md5gg(d, a, b, c, x[i + 2], 9, -51403784); c = md5gg(c, d, a, b, x[i + 7], 14, 1735328473); b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734);
        a = md5hh(a, b, c, d, x[i + 5], 4, -378558); d = md5hh(d, a, b, c, x[i + 8], 11, -2022574463); c = md5hh(c, d, a, b, x[i + 11], 16, 1839030562); b = md5hh(b, c, d, a, x[i + 14], 23, -35309556);
        a = md5hh(a, b, c, d, x[i + 1], 4, -1530992060); d = md5hh(d, a, b, c, x[i + 4], 11, 1272893353); c = md5hh(c, d, a, b, x[i + 7], 16, -155497632); b = md5hh(b, c, d, a, x[i + 10], 23, -1094730640);
        a = md5hh(a, b, c, d, x[i + 13], 4, 681279174); d = md5hh(d, a, b, c, x[i], 11, -358537222); c = md5hh(c, d, a, b, x[i + 3], 16, -722521979); b = md5hh(b, c, d, a, x[i + 6], 23, 76029189);
        a = md5hh(a, b, c, d, x[i + 9], 4, -640364487); d = md5hh(d, a, b, c, x[i + 12], 11, -421815835); c = md5hh(c, d, a, b, x[i + 15], 16, 530742520); b = md5hh(b, c, d, a, x[i + 2], 23, -995338651);
        a = md5ii(a, b, c, d, x[i], 6, -198630844); d = md5ii(d, a, b, c, x[i + 7], 10, 1126891415); c = md5ii(c, d, a, b, x[i + 14], 15, -1416354905); b = md5ii(b, c, d, a, x[i + 5], 21, -57434055);
        a = md5ii(a, b, c, d, x[i + 12], 6, 1700485571); d = md5ii(d, a, b, c, x[i + 3], 10, -1894986606); c = md5ii(c, d, a, b, x[i + 10], 15, -1051523); b = md5ii(b, c, d, a, x[i + 1], 21, -2054922799);
        a = md5ii(a, b, c, d, x[i + 8], 6, 1873313359); d = md5ii(d, a, b, c, x[i + 15], 10, -30611744); c = md5ii(c, d, a, b, x[i + 6], 15, -1560198380); b = md5ii(b, c, d, a, x[i + 13], 21, 1309151649);
        a = md5ii(a, b, c, d, x[i + 4], 6, -145523070); d = md5ii(d, a, b, c, x[i + 11], 10, -1120210379); c = md5ii(c, d, a, b, x[i + 2], 15, 718787259); b = md5ii(b, c, d, a, x[i + 9], 21, -343485551);
        a = safeAdd(a, olda); b = safeAdd(b, oldb); c = safeAdd(c, oldc); d = safeAdd(d, oldd);
      }
      return [a, b, c, d];
    }
    function binl2hex(binarray) {
      var hexTab = '0123456789abcdef', str = '';
      for (var i = 0; i < binarray.length * 4; i++) {
        str += hexTab.charAt((binarray[i >> 2] >> ((i % 4) * 8 + 4)) & 0xf) + hexTab.charAt((binarray[i >> 2] >> ((i % 4) * 8)) & 0xf);
      }
      return str;
    }
    function str2binl(str) {
      var bin = [], mask = (1 << 8) - 1;
      for (var i = 0; i < str.length * 8; i += 8) bin[i >> 5] |= (str.charCodeAt(i / 8) & mask) << (i % 32);
      return bin;
    }
    function utf8Encode(str) {
      return unescape(encodeURIComponent(str)); // 标准 utf8 字节序列
    }
    return function (s) {
      var bytes = utf8Encode(s);
      return binl2hex(binlMD5(str2binl(bytes), bytes.length * 8));
    };
  })();

  /** 百度翻译（免费额度，需 appid+key，MD5 签名） */
  async function translateBaidu(text) {
    var cfg = settings.baidu;
    var salt = String(Date.now() + Math.floor(Math.random() * 1000));
    var sign = md5(cfg.appid + text + salt + cfg.key);
    var url = 'https://fanyi-api.baidu.com/api/trans/vip/translate?q=' + encodeURIComponent(text) +
      '&from=auto&to=zh&appid=' + encodeURIComponent(cfg.appid) + '&salt=' + salt + '&sign=' + sign;
    var r = await fetchWithTimeout(url);
    if (!r.ok) throw new Error('baidu ' + r.status);
    var j = await r.json();
    if (j.error_code) throw new Error('baidu ' + j.error_code);
    var t = j.trans_result && j.trans_result[0] && j.trans_result[0].dst;
    if (!t) throw new Error('baidu empty');
    return t;
  }

  /** AI API（OpenAI 兼容接口，批量翻译，一次请求翻译多段） */
  async function translateAI(texts) {
    var cfg = settings.ai;
    var url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    var system = 'You are a professional translator. Translate each text from English to Simplified Chinese (zh-CN). ' +
      'Return ONLY a JSON array of translated strings, with the same length and order as the input array. ' +
      'Do not add explanations or markdown. Keep technical terms reasonably translated or as-is when appropriate.';
    var r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(texts) },
        ],
        temperature: 0.3,
      }),
    }, 60000);
    if (!r.ok) throw new Error('ai ' + r.status);
    var j = await r.json();
    var content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!content) throw new Error('ai empty');
    content = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    var arr;
    try { arr = JSON.parse(content); } catch (e) { throw new Error('ai bad json'); }
    if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error('ai bad shape');
    return arr.map(function (x, i) { return typeof x === 'string' ? x : String(x); });
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

  /** 根据设置返回后端尝试顺序 */
  function backendOrder() {
    var b = settings.backend;
    if (b === 'google') return ['google', 'bing', 'mymemory'];
    if (b === 'bing') return ['bing', 'google', 'mymemory'];
    if (b === 'mymemory') return ['mymemory', 'google', 'bing'];
    if (b === 'baidu') return ['baidu', 'google', 'bing', 'mymemory'];
    if (b === 'ai') return ['ai', 'google', 'bing', 'mymemory'];
    return ['google', 'bing', 'mymemory']; // auto
  }

  /** 翻译一批文本；按设置的顺序尝试后端，失败自动降级；返回 Map<原文本, 译文> */
  async function translateBatch(texts) {
    var results = {};
    // 先填缓存
    for (var ci = 0; ci < texts.length; ci++) {
      var cv = getCached(texts[ci]);
      if (cv) results[texts[ci]] = cv;
    }
    var order = backendOrder();
    for (var bi = 0; bi < order.length; bi++) {
      var name = order[bi];
      var rest = texts.filter(function (x) { return results[x] === undefined; });
      if (!rest.length) break;
      if (backendState[name] === 'bad') continue;
      // 需要配置的后端：未配置则跳过（不标记失败）
      if (name === 'baidu' && (!settings.baidu.appid || !settings.baidu.key)) continue;
      if (name === 'ai' && (!settings.ai.apiKey || !settings.ai.baseUrl)) continue;
      try {
        if (name === 'google') {
          var gOut = await mapWithConcurrency(rest, MAX_CONCURRENCY, function (t) {
            var c = getCached(t);
            return c ? Promise.resolve(c) : translateGoogle(t);
          }, 3);
          var gFails = 0;
          for (var i = 0; i < rest.length; i++) {
            if (gOut[i] === null) gFails++;
            else if (isGoodTranslation(gOut[i], rest[i])) { results[rest[i]] = gOut[i]; setCached(rest[i], gOut[i]); }
          }
          if (gFails > rest.length / 2) markBackend('google', false);
        } else if (name === 'bing') {
          var arr = await translateBing(rest);
          for (var j = 0; j < rest.length; j++) {
            if (isGoodTranslation(arr[j], rest[j])) { results[rest[j]] = arr[j]; setCached(rest[j], arr[j]); }
          }
        } else if (name === 'mymemory') {
          var mmOut = await mapWithConcurrency(rest, 2, translateMyMemory);
          for (var k = 0; k < rest.length; k++) {
            if (isGoodTranslation(mmOut[k], rest[k])) { results[rest[k]] = mmOut[k]; setCached(rest[k], mmOut[k]); }
          }
        } else if (name === 'baidu') {
          var bdOut = await mapWithConcurrency(rest, 3, translateBaidu);
          for (var l = 0; l < rest.length; l++) {
            if (isGoodTranslation(bdOut[l], rest[l])) { results[rest[l]] = bdOut[l]; setCached(rest[l], bdOut[l]); }
          }
        } else if (name === 'ai') {
          var aiOut = await translateAI(rest);
          for (var m = 0; m < rest.length; m++) {
            if (isGoodTranslation(aiOut[m], rest[m])) { results[rest[m]] = aiOut[m]; setCached(rest[m], aiOut[m]); }
          }
        }
      } catch (e) {
        markBackend(name, false);
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
    try {
      translateBatch(texts)
        .then(function (results) { applyResults(items, results); })
        .catch(function () { /* 静默 */ })
        .finally(function () { busy = false; });
    } catch (e) {
      busy = false;
    }
  }

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 900);
  }

  // ==================== 开关 & 设置 ====================
  function isEnabled() {
    var v = null;
    try { v = localStorage.getItem(SETTING_KEY); } catch (e) { /* ignore */ }
    return v !== '0';
  }

  var toggleBtn = null;
  var settingsBtn = null;

  function inputStyle() {
    return 'width:100%;box-sizing:border-box;background:#333;border:1px solid #454545;border-radius:4px;' +
      'color:#ddd;padding:6px 8px;margin:4px 0;font:13px "Segoe UI","Microsoft YaHei",sans-serif;outline:none;';
  }

  function ensureSettingsPanel() {
    var panel = document.getElementById('wh-settings-panel');
    if (panel && panel.isConnected) return panel;

    panel = document.createElement('div');
    panel.id = 'wh-settings-panel';
    panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:none;';
    panel.innerHTML =
      '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:400px;max-width:92vw;' +
      'background:#252526;border:1px solid #454545;border-radius:10px;padding:16px 18px;color:#ddd;' +
      'font:13px/1.7 "Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.6);">' +
      '<div style="font-size:15px;font-weight:600;color:#fff;margin-bottom:10px;">⚙ 翻译设置</div>' +
      '<div style="color:#aaa;margin:6px 0 4px;">翻译后端</div>' +
      '<label style="display:block;padding:2px 0;"><input type="radio" name="wh-backend" value="auto"> 自动（Google → Bing → MyMemory）</label>' +
      '<label style="display:block;padding:2px 0;"><input type="radio" name="wh-backend" value="google"> Google 翻译</label>' +
      '<label style="display:block;padding:2px 0;"><input type="radio" name="wh-backend" value="bing"> Bing 翻译</label>' +
      '<label style="display:block;padding:2px 0;"><input type="radio" name="wh-backend" value="mymemory"> MyMemory</label>' +
      '<label style="display:block;padding:2px 0;"><input type="radio" name="wh-backend" value="baidu"> 百度翻译（需 AppID + 密钥）</label>' +
      '<label style="display:block;padding:2px 0;"><input type="radio" name="wh-backend" value="ai"> AI API（OpenAI 兼容）</label>' +
      '<div id="wh-cfg-baidu" style="display:none;margin-top:8px;background:#1e1e1e;padding:8px 10px;border-radius:6px;">' +
      '<div style="color:#aaa;">百度翻译 API（fanyi-api.baidu.com 免费申请，每月 5 万字符）</div>' +
      '<input id="wh-baidu-appid" placeholder="AppID" style="' + inputStyle() + '">' +
      '<input id="wh-baidu-key" placeholder="密钥 Key" style="' + inputStyle() + '">' +
      '</div>' +
      '<div id="wh-cfg-ai" style="display:none;margin-top:8px;background:#1e1e1e;padding:8px 10px;border-radius:6px;">' +
      '<div style="color:#aaa;">OpenAI 兼容接口：DeepSeek / OpenAI / 通义千问 / Kimi 等</div>' +
      '<input id="wh-ai-base" placeholder="Base URL，如 https://api.deepseek.com/v1" style="' + inputStyle() + '">' +
      '<input id="wh-ai-key" type="password" placeholder="API Key" style="' + inputStyle() + '">' +
      '<input id="wh-ai-model" placeholder="模型，如 deepseek-chat / gpt-4o-mini / qwen-turbo" style="' + inputStyle() + '">' +
      '</div>' +
      '<div style="margin-top:14px;text-align:right;">' +
      '<button id="wh-cfg-cancel" style="background:#3a3a3a;color:#ccc;border:1px solid #555;border-radius:5px;padding:5px 16px;margin-right:8px;cursor:pointer;font-size:13px;">取消</button>' +
      '<button id="wh-cfg-save" style="background:#0a84ff;color:#fff;border:none;border-radius:5px;padding:5px 16px;cursor:pointer;font-size:13px;">保存</button>' +
      '</div>' +
      '<div style="margin-top:8px;color:#888;font-size:11px;">API Key 仅保存在本机（localStorage），不会上传到任何服务器。</div>' +
      '</div>';
    document.body.appendChild(panel);

    // 后端选择切换时显示对应配置区
    panel.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'wh-backend') {
        var v = e.target.value;
        panel.querySelector('#wh-cfg-baidu').style.display = v === 'baidu' ? 'block' : 'none';
        panel.querySelector('#wh-cfg-ai').style.display = v === 'ai' ? 'block' : 'none';
      }
    });
    panel.querySelector('#wh-cfg-cancel').onclick = function () { panel.style.display = 'none'; };
    panel.querySelector('#wh-cfg-save').onclick = function () {
      var sel = panel.querySelector('input[name="wh-backend"]:checked');
      if (sel) settings.backend = sel.value;
      settings.baidu.appid = panel.querySelector('#wh-baidu-appid').value.trim();
      settings.baidu.key = panel.querySelector('#wh-baidu-key').value.trim();
      settings.ai.baseUrl = panel.querySelector('#wh-ai-base').value.trim() || DEFAULT_CONFIG.ai.baseUrl;
      settings.ai.apiKey = panel.querySelector('#wh-ai-key').value.trim();
      settings.ai.model = panel.querySelector('#wh-ai-model').value.trim() || DEFAULT_CONFIG.ai.model;
      saveConfig();
      panel.style.display = 'none';
      // 重置后端运行状态并立即重新翻译
      backendState = {};
      scheduleScan();
    };
    return panel;
  }

  function openSettings() {
    var panel = ensureSettingsPanel();
    // 填入当前设置
    var radios = panel.querySelectorAll('input[name="wh-backend"]');
    for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === settings.backend;
    panel.querySelector('#wh-baidu-appid').value = settings.baidu.appid;
    panel.querySelector('#wh-baidu-key').value = settings.baidu.key;
    panel.querySelector('#wh-ai-base').value = settings.ai.baseUrl;
    panel.querySelector('#wh-ai-key').value = settings.ai.apiKey;
    panel.querySelector('#wh-ai-model').value = settings.ai.model;
    panel.querySelector('#wh-cfg-baidu').style.display = settings.backend === 'baidu' ? 'block' : 'none';
    panel.querySelector('#wh-cfg-ai').style.display = settings.backend === 'ai' ? 'block' : 'none';
    panel.style.display = 'block';
  }

  function ensureToggleButton() {
    if (toggleBtn && toggleBtn.isConnected && settingsBtn && settingsBtn.isConnected) return;
    var holder = document.createElement('div');
    holder.id = 'wh-toggle-holder';
    holder.style.cssText =
      'position:fixed;right:14px;bottom:14px;z-index:2147483646;display:flex;gap:6px;' +
      'font-family:"Segoe UI","Microsoft YaHei",sans-serif;';
    toggleBtn = document.createElement('button');
    toggleBtn.id = 'wh-translate-toggle';
    toggleBtn.textContent = '🌐 译';
    toggleBtn.title = 'Mod 介绍自动翻译（点击开关）';
    toggleBtn.style.cssText =
      'background:rgba(0,120,212,.92);color:#fff;border:none;border-radius:14px;' +
      'padding:5px 12px;font-size:12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);opacity:.55;' +
      'transition:opacity .2s;';
    settingsBtn = document.createElement('button');
    settingsBtn.id = 'wh-settings-toggle';
    settingsBtn.textContent = '⚙';
    settingsBtn.title = '翻译设置（选择后端 / 配置 AI API）';
    settingsBtn.style.cssText =
      'background:rgba(80,80,80,.92);color:#fff;border:none;border-radius:14px;' +
      'padding:5px 10px;font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);opacity:.55;' +
      'transition:opacity .2s;';
    var dim = function (b) {
      b.onmouseenter = function () { b.style.opacity = '1'; };
      b.onmouseleave = function () { b.style.opacity = '.55'; };
    };
    dim(toggleBtn); dim(settingsBtn);
    toggleBtn.onclick = function () {
      var now = isEnabled();
      try { localStorage.setItem(SETTING_KEY, now ? '0' : '1'); } catch (e) { /* ignore */ }
      toggleBtn.style.background = now ? 'rgba(120,120,120,.92)' : 'rgba(0,120,212,.92)';
      if (!now) scheduleScan();
    };
    settingsBtn.onclick = openSettings;
    if (!isEnabled()) toggleBtn.style.background = 'rgba(120,120,120,.92)';
    holder.appendChild(settingsBtn);
    holder.appendChild(toggleBtn);
    document.body.appendChild(holder);
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
