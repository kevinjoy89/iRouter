"use client";

import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from "./config.js";

let translationMap = {};
let currentLocale = DEFAULT_LOCALE;
let reloadCallbacks = [];

// Read locale from cookie
function getLocaleFromCookie() {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : DEFAULT_LOCALE;
  return normalizeLocale(value);
}

// Load translation map
async function loadTranslations(locale) {
  if (locale === "en") {
    translationMap = {};
    return;
  }
  
  try {
    const response = await fetch(`/i18n/literals/${locale}.json`);
    translationMap = await response.json();
  } catch (err) {
    console.error("Failed to load translations:", err);
    translationMap = {};
  }
}

/**
 * 动态模式正则翻译器
 * 针对带动态参数、数量或类别拼接的英文文本进行中/繁匹配翻译
 * @param {string} text 待翻译的原始文本
 * @param {string} locale 当前语言代码
 * @return {string} 翻译后的文本，若无匹配则返回原文本
 */
function translateDynamicPatterns(text, locale) {
  const isZh = locale === "zh-CN";
  const isTw = locale === "zh-TW";
  if (!isZh && !isTw) return text;

  // 1. 分页 "Showing 0-0 of 0" / "Showing 1-20 of 35" / "Showing 1 to 20 of 35 results"
  const showingMatch = text.match(/^Showing\s+(\d+)(?:\s*-\s*|\s+to\s+)(\d+)\s+of\s+(\d+)(?:\s+results)?$/i);
  if (showingMatch) {
    return isTw
      ? `顯示 ${showingMatch[1]}-${showingMatch[2]} / 共 ${showingMatch[3]} 條`
      : `显示 ${showingMatch[1]}-${showingMatch[2]} / 共 ${showingMatch[3]} 条`;
  }

  // 2. 每页条数 "20 / page" 及独立后缀 "/ page"
  const perPageMatch = text.match(/^(\d+)\s*[/]\s*page$/i);
  if (perPageMatch) {
    return isTw ? `${perPageMatch[1]} 條 / 頁` : `${perPageMatch[1]} 条 / 页`;
  }
  const perPageSuffixMatch = text.match(/^[/]\s*page$/i);
  if (perPageSuffixMatch) {
    return isTw ? "/ 頁" : "/ 页";
  }

  // 3. 页码 "Page 1 / 1" / "Page1/1"
  const pageMatch = text.match(/^Page\s*(\d+)\s*[/]\s*(\d+)$/i);
  if (pageMatch) {
    return isTw ? `第 ${pageMatch[1]} / ${pageMatch[2]} 頁` : `第 ${pageMatch[1]} / ${pageMatch[2]} 页`;
  }

  // 4. 配额与连接计数 "1 quota", "2 quotas", "0 connections", "1 connection"
  const quotaMatch = text.match(/^(\d+)\s+quotas?$/i);
  if (quotaMatch) {
    return isTw ? `${quotaMatch[1]} 個配額` : `${quotaMatch[1]} 个配额`;
  }
  const connectionCountMatch = text.match(/^(\d+)\s+connections?$/i);
  if (connectionCountMatch) {
    return isTw ? `${connectionCountMatch[1]} 個連線` : `${connectionCountMatch[1]} 个连接`;
  }
  const usingStoredKeysMatch = text.match(/^Using\s+stored\s+key\(s\)\s+·\s+(\d+)\s+connections?$/i);
  if (usingStoredKeysMatch) {
    return isTw
      ? `使用已儲存的金鑰 · ${usingStoredKeysMatch[1]} 個連線`
      : `使用已保存的密钥 · ${usingStoredKeysMatch[1]} 个连接`;
  }
  const resetCreditMatch = text.match(/^(\d+)\s+reset\s+credits?$/i);
  if (resetCreditMatch) {
    return isTw ? `${resetCreditMatch[1]} 次重設額度` : `${resetCreditMatch[1]} 次重置额度`;
  }
  const availableMatch = text.match(/^(\d+)\s+available$/i);
  if (availableMatch) {
    return isTw ? `${availableMatch[1]} 個可用` : `${availableMatch[1]} 个可用`;
  }

  // 4.1 展开提供商 "Show all 39 providers"
  const showAllProvidersMatch = text.match(/^Show\s+all\s+(\d+)\s+providers$/i);
  if (showAllProvidersMatch) {
    return isTw ? `顯示全部 ${showAllProvidersMatch[1]} 個提供商` : `显示全部 ${showAllProvidersMatch[1]} 个提供商`;
  }

  // 5. 供应商凭据弹窗标题 "Add <provider> API Key" 等
  const addKeyMatch = text.match(/^Add\s+(.+?)\s+API\s+Key$/i);
  if (addKeyMatch) {
    return isTw ? `新增 ${addKeyMatch[1]} API 金鑰` : `添加 ${addKeyMatch[1]} API 密钥`;
  }
  const addCookieMatch = text.match(/^Add\s+(.+?)\s+Cookie\s+Value$/i);
  if (addCookieMatch) {
    return isTw ? `新增 ${addCookieMatch[1]} Cookie 值` : `添加 ${addCookieMatch[1]} Cookie 值`;
  }
  const addPatMatch = text.match(/^Add\s+(.+?)\s+Personal\s+Access\s+Token\s*\(PAT\)$/i);
  if (addPatMatch) {
    return isTw ? `新增 ${addPatMatch[1]} 個人存取權杖 (PAT)` : `添加 ${addPatMatch[1]} 个人访问令牌 (PAT)`;
  }

  // 6. 代理绑定数量 "Apply Proxy (1 connection)" 与删除连接确认
  const applyProxyMatch = text.match(/^Apply\s+Proxy\s*\(\s*(\d+)\s+connections?\s*\)$/i);
  if (applyProxyMatch) {
    return isTw ? `套用代理（${applyProxyMatch[1]} 個連線）` : `应用代理（${applyProxyMatch[1]} 个连接）`;
  }
  const deleteConnsTitleMatch = text.match(/^Delete\s+(\d+)\s+connections?$/i);
  if (deleteConnsTitleMatch) {
    return isTw ? `刪除 ${deleteConnsTitleMatch[1]} 個連線` : `删除 ${deleteConnsTitleMatch[1]} 个连接`;
  }
  const deleteConnsMsgMatch = text.match(/^Delete\s+(\d+)\s+connections?\?\s+This\s+cannot\s+be\s+undone\.$/i);
  if (deleteConnsMsgMatch) {
    return isTw
      ? `刪除這 ${deleteConnsMsgMatch[1]} 個連線？此操作無法復原。`
      : `删除这 ${deleteConnsMsgMatch[1]} 个连接？此操作无法撤销。`;
  }

  // 7. 社交登录连接 "Connect Kiro via <provider>" 及通用 "Connect <provider>"
  const kiroViaMatch = text.match(/^Connect\s+Kiro\s+via\s+(.+)$/i);
  if (kiroViaMatch) {
    return isTw ? `透過 ${kiroViaMatch[1]} 連線 Kiro` : `通过 ${kiroViaMatch[1]} 连接 Kiro`;
  }
  const connectProviderMatch = text.match(/^Connect\s+(.+)$/i);
  if (connectProviderMatch) {
    return isTw ? `連接 ${connectProviderMatch[1]}` : `连接 ${connectProviderMatch[1]}`;
  }

  // 7.1 账号已连接动态提示 "Your <provider> account has been connected."
  const accountConnectedMatch = text.match(/^Your\s+(.+?)\s+account\s+has\s+been\s+connected\.$/i);
  if (accountConnectedMatch) {
    return isTw ? `您的 ${accountConnectedMatch[1]} 帳號已成功連線。` : `您的 ${accountConnectedMatch[1]} 账号已成功连接。`;
  }

  // 8. 兼容节点编辑 "Edit Anthropic Compatible Node" / "Edit OpenAI Compatible Node"
  const editCompatMatch = text.match(/^Edit\s+(Anthropic|OpenAI)\s+Compatible\s+Node$/i);
  if (editCompatMatch) {
    return isTw ? `編輯 ${editCompatMatch[1]} 相容節點` : `编辑 ${editCompatMatch[1]} 兼容节点`;
  }

  // 9. 代理池轮换动态提示
  const rotatePoolsMatch = text.match(/^Rotating\s+through\s+all\s+(\d+)\s+active\s+pools\s+in\s+order\.\s+State\s+is\s+in-memory\s*\(resets\s+on\s+restart\)\.$/i);
  if (rotatePoolsMatch) {
    return isTw
      ? `按順序在全部 ${rotatePoolsMatch[1]} 個活躍代理池間輪換。狀態儲存在記憶體中（重啟後重設）。`
      : `按顺序在全部 ${rotatePoolsMatch[1]} 个活跃代理池间轮换。状态保存在内存中（重启后重置）。`;
  }
  const randomPoolMatch = text.match(/^Picking\s+a\s+random\s+pool\s+from\s+(\d+)\s+active\s+pools\s+each\s+request\.$/i);
  if (randomPoolMatch) {
    return isTw
      ? `每次請求從 ${randomPoolMatch[1]} 個活躍代理池中隨機選取一個。`
      : `每次请求从 ${randomPoolMatch[1]} 个活跃代理池中随机选择一个。`;
  }

  // 10. 媒体类型配置卡片标题 "类别 Config"
  const mediaConfigMatch = text.match(/^(.+?)\s+Config$/i);
  if (mediaConfigMatch) {
    const rawKind = mediaConfigMatch[1];
    const kindDict = {
      "Text To Speech": isTw ? "文字轉語音設定" : "文本转语音配置",
      "Speech To Text": isTw ? "語音轉文字設定" : "语音转文本配置",
      "Text to Image": isTw ? "文字轉影像設定" : "文本转图像配置",
      "Image to Text": isTw ? "影像轉文字設定" : "图像转文本配置",
      "Embedding": isTw ? "嵌入設定" : "嵌入配置",
      "Web Search": isTw ? "Web 搜尋設定" : "Web 搜索配置",
      "Web Fetch": isTw ? "Web 擷取設定" : "Web 抓取配置",
      "Video": isTw ? "影片設定" : "视频配置",
      "Music": isTw ? "音樂設定" : "音乐配置",
    };
    if (kindDict[rawKind]) {
      return kindDict[rawKind];
    }
  }

  // 11. 媒体提供商卡片连接统计状态 "1 Connected" / "2 Error" / "3 Added"
  const connStatMatch = text.match(/^(\d+)\s+(Connected|Error|Added)$/i);
  if (connStatMatch) {
    const count = connStatMatch[1];
    const statType = connStatMatch[2].toLowerCase();
    if (statType === "connected") {
      return isTw ? `${count} 個已連線` : `${count} 个已连接`;
    }
    if (statType === "error") {
      return isTw ? `${count} 個錯誤` : `${count} 个错误`;
    }
    if (statType === "added") {
      return isTw ? `${count} 個已新增` : `${count} 个已添加`;
    }
  }

  // 12. 媒体提供商统计摘要 "(X providers · Y combos)"
  const comboSummaryMatch = text.match(/^\((\d+)\s+providers\s+·\s+(\d+)\s+combos\)$/i);
  if (comboSummaryMatch) {
    return isTw
      ? `（${comboSummaryMatch[1]} 個供應商 · ${comboSummaryMatch[2]} 個組合）`
      : `（${comboSummaryMatch[1]} 个供应商 · ${comboSummaryMatch[2]} 个组合）`;
  }

  // 13. MITM 拦截与 DNS 提示
  const interceptViaMitmMatch = text.match(/^Intercept\s+(.+?)\s+requests\s+via\s+MITM\s+proxy$/i);
  if (interceptViaMitmMatch) {
    return isTw
      ? `透過 MITM 代理攔截 ${interceptViaMitmMatch[1]} 請求`
      : `通过 MITM 代理拦截 ${interceptViaMitmMatch[1]} 请求`;
  }
  const toggleDnsMatch = text.match(/^Toggle\s+DNS\s+to\s+redirect\s+(.+?)\s+traffic\s+through\s+(?:9Router|iRouter)\s+via\s+MITM\.$/i);
  if (toggleDnsMatch) {
    return isTw
      ? `切換 DNS 以透過 MITM 將 ${toggleDnsMatch[1]} 流量重定向至 iRouter。`
      : `切换 DNS 以通过 MITM 将 ${toggleDnsMatch[1]} 流量重定向至 iRouter。`;
  }

  // 13. 添加模型模态框标题 "Add <kind> Model" / "Add <kind> Model to Combo"
  const addModelMatch = text.match(/^Add\s+(.+?)\s+Model(\s+to\s+Combo)?$/i);
  if (addModelMatch) {
    const targetKind = addModelMatch[1];
    const isToCombo = !!addModelMatch[2];
    return isTw
      ? (isToCombo ? `新增 ${targetKind} 模型至組合` : `新增 ${targetKind} 模型`)
      : (isToCombo ? `添加 ${targetKind} 模型到组合` : `添加 ${targetKind} 模型`);
  }

  return text;
}

// Translate text - exported for use in components
export function translate(text) {
  if (!text || typeof text !== "string") return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (currentLocale === "en") return text;
  if (translationMap[trimmed]) return translationMap[trimmed];
  return translateDynamicPatterns(trimmed, currentLocale);
}

// Get current locale - exported for use in components
export function getCurrentLocale() {
  return currentLocale;
}

// Register callback for locale changes
export function onLocaleChange(callback) {
  reloadCallbacks.push(callback);
  return () => {
    reloadCallbacks = reloadCallbacks.filter(cb => cb !== callback);
  };
}

// Process text node
export function processTextNode(node) {
  if (!node.nodeValue || !node.nodeValue.trim()) return;
  
  // Skip if parent is script, style, code, or structural elements
  const parent = node.parentElement;
  if (!parent) return;
  
  // Skip if parent or any ancestor has data-i18n-skip attribute
  let element = parent;
  while (element) {
    if (element.hasAttribute && element.hasAttribute('data-i18n-skip')) {
      return;
    }
    element = element.parentElement;
  }
  
  const tagName = parent.tagName?.toLowerCase();
  
  // Skip elements that don't allow text nodes
  const skipTags = [
    "script", "style", "code", "pre",
    "colgroup", "select", "datalist", "optgroup"
  ];
  
  if (skipTags.includes(tagName)) return;
  
  // Store original text if not already stored. React updates text nodes in place
  // and characterData is not observed, so a cached original goes stale: re-capture
  // whenever the node no longer holds what we wrote last, otherwise a later
  // full-DOM pass (route/locale change) reverts dynamic text to its mount-time
  // value — counters and connection labels would freeze while the rest re-renders.
  if (!node._originalText || node._i18nApplied !== node.nodeValue) {
    node._originalText = node.nodeValue;
  }
  
  // Use original text for translation
  const original = node._originalText;
  const translated = translate(original);
  node._i18nApplied = translated;
  
  // Only update if different to avoid unnecessary DOM mutations
  if (translated !== node.nodeValue) {
    node.nodeValue = translated;
  }
}

// Process all text nodes in element
function processElement(element) {
  if (!element) return;
  
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );
  
  let node;
  const nodesToProcess = [];
  
  // Collect all nodes first to avoid live collection issues
  while ((node = walker.nextNode())) {
    nodesToProcess.push(node);
  }
  
  // Process collected nodes
  nodesToProcess.forEach(processTextNode);

  // Tooltip attributes follow the same dictionary (exact-match, idempotent:
  // already-translated values miss the English key and are left untouched)
  processElementTitles(element);
  processElementPlaceholders(element);
}

// Translate title attributes (tooltips). Mirrors processTextNode's contract.
function processTitle(element) {
  if (!element?.getAttribute) return;
  if (element.closest?.("[data-i18n-skip]")) return;
  const current = element.getAttribute("title");
  if (!current) return;
  const translated = translate(current);
  if (translated === current) return;
  element.setAttribute("title", translated);
}

function processElementTitles(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
  processTitle(element);
  element.querySelectorAll?.("[title]").forEach(processTitle);
}

/**
 * 翻译元素上的 placeholder 属性
 * @param {Element} element 目标 DOM 节点
 */
function processPlaceholder(element) {
  if (!element?.getAttribute) return;
  if (element.closest?.("[data-i18n-skip]")) return;
  const current = element.getAttribute("placeholder");
  if (!current) return;
  if (element._i18nOrigPlaceholder === undefined) {
    element._i18nOrigPlaceholder = current;
  }
  const orig = element._i18nOrigPlaceholder;
  const translated = translate(orig);
  if (element.getAttribute("placeholder") !== translated) {
    element.setAttribute("placeholder", translated);
  }
}

/**
 * 遍历并翻译元素内的所有 input 与 textarea 的 placeholder 属性
 * @param {Element} element 根容器节点
 */
function processElementPlaceholders(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
  processPlaceholder(element);
  element.querySelectorAll?.("input[placeholder], textarea[placeholder]").forEach(processPlaceholder);
}

// Initialize runtime i18n
export async function initRuntimeI18n() {
  if (typeof window === "undefined") return;
  
  currentLocale = getLocaleFromCookie();
  await loadTranslations(currentLocale);
  
  // Process existing DOM
  processElement(document.body);
  
  // Watch for new nodes
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      // React re-renders reset title / placeholder attributes — re-translate on change
      if (mutation.type === "attributes") {
        if (mutation.attributeName === "title") {
          processTitle(mutation.target);
        } else if (mutation.attributeName === "placeholder") {
          processPlaceholder(mutation.target);
        }
        return;
      }
      // React re-renders mutate text node values in place — re-translate on characterData change
      if (mutation.type === "characterData") {
        const node = mutation.target;
        // Skip if this change was made by our own translation to avoid infinite loops
        if (node._i18nApplied === node.nodeValue) return;
        processTextNode(node);
        return;
      }
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          processElement(node);
        } else if (node.nodeType === Node.TEXT_NODE) {
          processTextNode(node);
        }
      });
    });
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["title", "placeholder"],
  });
}

// Reload translations when locale changes
export async function reloadTranslations() {
  currentLocale = getLocaleFromCookie();
  await loadTranslations(currentLocale);
  
  // Notify all registered callbacks
  reloadCallbacks.forEach(callback => callback());
  
  // Re-process entire DOM (will use stored original text)
  processElement(document.body);
}
