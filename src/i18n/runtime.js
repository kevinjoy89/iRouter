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
export function translateDynamicPatterns(text, locale) {
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

  // 7.2 筛选选择框 "All Statuses"
  if (text.trim() === "All Statuses") {
    return isTw ? "所有狀態" : "所有状态";
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
  const addModelMatch = text.match(/^Add(?:\s+(.+?))?\s+Model(\s+to\s+Combo)?$/i);
  if (addModelMatch) {
    const targetKind = addModelMatch[1];
    const isToCombo = !!addModelMatch[2];
    if (targetKind) {
      return isTw
        ? (isToCombo ? `新增 ${targetKind} 模型至組合` : `新增 ${targetKind} 模型`)
        : (isToCombo ? `添加 ${targetKind} 模型到组合` : `添加 ${targetKind} 模型`);
    }
    return isTw
      ? (isToCombo ? "新增模型至組合" : "新增模型")
      : (isToCombo ? "添加模型到组合" : "添加模型");
  }

  // 14. 端点与密钥：允许调用的组合/模型弹窗标题 "Allowed for \"<name>\""
  const allowedForMatch = text.match(/^Allowed\s+for\s+"(.+?)"$/i);
  if (allowedForMatch) {
    return isTw ? `已為 "${allowedForMatch[1]}" 允許` : `已为 "${allowedForMatch[1]}" 允许`;
  }

  // 14.1 限制密钥确认弹窗提示
  const restrictKeyConfirmMatch = text.match(
    /^Restrict\s+API\s+key\s+"(.+?)"\?\s+It\s+will\s+only\s+be\s+able\s+to\s+call\s+the\s+combos\s+and\s+models\s+you\s+add\.\s+Until\s+you\s+add\s+one,\s+it\s+can\s+call\s+nothing\.$/i,
  );
  if (restrictKeyConfirmMatch) {
    return isTw
      ? `限制 API 金鑰 "${restrictKeyConfirmMatch[1]}"？該金鑰將只能呼叫您新增的組合和模型。在您新增之前，它無法呼叫任何內容。`
      : `限制 API 密钥 "${restrictKeyConfirmMatch[1]}"？该密钥将只能调用您添加的组合和模型。在您添加之前，它无法调用任何内容。`;
  }

  // 15. 组合全选与选择计数 "Select all (N)" / "N selected"
  const selectAllMatch = text.match(/^Select\s+all\s*\(\s*(\d+)\s*\)$/i);
  if (selectAllMatch) {
    return isTw ? `全選 (${selectAllMatch[1]})` : `全选 (${selectAllMatch[1]})`;
  }
  const selectedCountMatch = text.match(/^(\d+)\s+selected$/i);
  if (selectedCountMatch) {
    return isTw ? `已選取 ${selectedCountMatch[1]} 項` : `已选择 ${selectedCountMatch[1]} 项`;
  }

  // 16. 上下文与最大输出 "ctx 128k" / "ctx1M" / "ctx1M · max384k"
  const ctxMaxCombinedMatch = text.match(/^ctx\s*([0-9a-zA-Z.]+)\s*·\s*max\s*([0-9a-zA-Z.]+)$/i);
  if (ctxMaxCombinedMatch) {
    return isTw
      ? `上下文 ${ctxMaxCombinedMatch[1]} · 最大 ${ctxMaxCombinedMatch[2]}`
      : `上下文 ${ctxMaxCombinedMatch[1]} · 最大 ${ctxMaxCombinedMatch[2]}`;
  }
  const ctxMatch = text.match(/^ctx\s*([0-9a-zA-Z.]+)$/i);
  if (ctxMatch) {
    return isTw ? `上下文 ${ctxMatch[1]}` : `上下文 ${ctxMatch[1]}`;
  }
  const maxOutputMatch = text.match(/^max\s*([0-9a-zA-Z.]+)$/i);
  if (maxOutputMatch) {
    return isTw ? `最大 ${maxOutputMatch[1]}` : `最大 ${maxOutputMatch[1]}`;
  }

  // 17. 组合更多模型计数 "+N more"
  const plusMoreMatch = text.match(/^\+(\d+)\s+more$/i);
  if (plusMoreMatch) {
    return isTw ? `+${plusMoreMatch[1]} 更多` : `+${plusMoreMatch[1]} 更多`;
  }

  // 18. 回退模型提示 "No models in pool (will fallback to <model>)" / "No models in pool (will fallback to<model>)"
  const noModelsPoolMatch = text.match(/^No\s+models\s+in\s+pool\s*\(will\s+fallback\s+to\s*(.+?)\)$/i);
  if (noModelsPoolMatch) {
    return isTw
      ? `池中暫無模型（將回退到 ${noModelsPoolMatch[1]}）`
      : `池中暂无模型（将回退到 ${noModelsPoolMatch[1]}）`;
  }

  // 19. 融合裁判自动选择 "Auto — <model>"
  const autoJudgeMatch = text.match(/^Auto\s*—\s*(.+)$/i);
  if (autoJudgeMatch) {
    return isTw ? `自動 — ${autoJudgeMatch[1]}` : `自动 — ${autoJudgeMatch[1]}`;
  }

  // 20. 配额倒计时 "in 22d 5h 40m" / "expires in 20h 25m"
  const quotaCountdownMatch = text.match(/^(in|expires\s+in)\s+(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/i);
  if (quotaCountdownMatch) {
    const isExpires = quotaCountdownMatch[1].toLowerCase().startsWith("expires");
    const d = quotaCountdownMatch[2];
    const h = quotaCountdownMatch[3];
    const m = quotaCountdownMatch[4];
    const s = quotaCountdownMatch[5];
    const parts = [];
    if (d) parts.push(`${d}天`);
    if (h) parts.push(isTw ? `${h}小時` : `${h}小时`);
    if (m) parts.push(isTw ? `${m}分鐘` : `${m}分钟`);
    if (s) parts.push(isTw ? `${s}秒` : `${s}秒`);
    const timeStr = parts.join(" ");
    if (isExpires) {
      return isTw ? `${timeStr}後到期` : `${timeStr}后到期`;
    }
    return isTw ? `${timeStr}後` : `${timeStr}后`;
  }

  // 20.1 赠送福利包 "Bonus Pack N"
  const bonusPackMatch = text.match(/^Bonus\s+Pack\s+(\d+)$/i);
  if (bonusPackMatch) {
    return isTw ? `福利包 ${bonusPackMatch[1]}` : `福利包 ${bonusPackMatch[1]}`;
  }

  // 21. CLI 工具检查与本地未安装提示 "Checking <tool>..." / "<tool> not detected locally"
  const checkingToolMatch = text.match(/^Checking\s+(.+?)\.\.\.$/i);
  if (checkingToolMatch) {
    return isTw ? `正在檢查 ${checkingToolMatch[1]}...` : `正在检查 ${checkingToolMatch[1]}...`;
  }
  const notDetectedMatch = text.match(/^(.+?)\s+not\s+detected\s+locally$/i);
  if (notDetectedMatch) {
    return isTw ? `本機未偵測到 ${notDetectedMatch[1]}` : `本地未检测到 ${notDetectedMatch[1]}`;
  }

  // 21.1 CLI 工具手动配置标题 "<tool> Configuration"
  const toolConfigMatch = text.match(/^(.+?)\s+Configuration$/i);
  if (toolConfigMatch) {
    return isTw ? `${toolConfigMatch[1]} 設定` : `${toolConfigMatch[1]} 配置`;
  }

  // 21.2 提供商配置卡片标题 "<kind> Config"
  const kindConfigMatch = text.match(/^(.+?)\s+Config$/i);
  if (kindConfigMatch) {
    const rawKind = kindConfigMatch[1].trim();
    const kindMap = {
      "System One": "System One",
      "Web Search": isTw ? "Web 搜尋" : "Web 搜索",
      "Web Fetch": isTw ? "Web 擷取" : "Web 抓取",
      "Embedding": isTw ? "嵌入" : "嵌入",
      "Speech To Text": isTw ? "語音轉文字" : "语音转文本",
      "Text To Speech": isTw ? "文字轉語音" : "文本转语音",
      "Text to Image": isTw ? "文字轉影像" : "文本转图像",
      "Image to Text": isTw ? "影像轉文字" : "图像转文本",
      "Image": isTw ? "影像" : "图像",
      "Video": isTw ? "影片" : "视频",
      "Music": isTw ? "音樂" : "音乐",
    };
    const translatedKind = kindMap[rawKind] || rawKind;
    return isTw ? `${translatedKind} 設定` : `${translatedKind} 配置`;
  }

  // 21.3 CLI 工具配置路径提示 "Config path: Linux/macOS ... • Windows ..."
  const configPathMatch = text.match(/^Config\s+path:\s*(.+)$/i);
  if (configPathMatch) {
    return isTw ? `設定路徑：${configPathMatch[1]}` : `配置路径：${configPathMatch[1]}`;
  }

  // 22. 媒体提供商头部页面描述 "Manage your <kind> providers"
  const manageProvidersMatch = text.match(/^Manage\s+your\s+(.+?)\s+providers$/i);
  if (manageProvidersMatch) {
    const rawKind = manageProvidersMatch[1].trim();
    const kindMap = {
      "Text To Speech": isTw ? "文字轉語音" : "文本转语音",
      "Speech To Text": isTw ? "語音轉文字" : "语音转文本",
      "Text to Image": isTw ? "文字轉影像" : "文本转图像",
      "Image to Text": isTw ? "影像轉文字" : "图像转文本",
      "Embedding": isTw ? "嵌入" : "嵌入",
      "Web Search": isTw ? "Web 搜尋" : "Web 搜索",
      "Web Fetch": isTw ? "Web 擷取" : "Web 抓取",
      "Video": isTw ? "影片" : "视频",
      "Music": isTw ? "音樂" : "音乐",
      "System One": "System One",
      "Web Fetch & Search": isTw ? "Web 擷取與搜尋" : "Web 抓取与搜索",
      "web": isTw ? "Web" : "Web",
      "AI provider": isTw ? "AI 提供商" : "AI 提供商",
    };
    const translatedKind = kindMap[rawKind] || rawKind;
    return isTw ? `管理您的 ${translatedKind} 供應商` : `管理您的 ${translatedKind} 供应商`;
  }

  // 23. 视觉与音频适配器选项 "Vision —images (png, jpg, webp, ...)" 与 "Audio —audio input"
  const visionMatch = text.match(/^Vision\s*(?:—|-)\s*images\s*\(([^)]+)\)$/i);
  if (visionMatch) {
    return isTw
      ? `視覺 — 影像 (${visionMatch[1]})`
      : `视觉 — 图像 (${visionMatch[1]})`;
  }
  const audioMatch = text.match(/^Audio\s*(?:—|-)\s*audio\s+input$/i);
  if (audioMatch) {
    return isTw ? "音訊 — 音訊輸入" : "音频 — 音频输入";
  }

  // 24. 动态测试与批量操作反馈
  const allTestsPassedMatch = text.match(/^All\s+(\d+)\s+tests\s+passed$/i);
  if (allTestsPassedMatch) {
    return isTw ? `全部 ${allTestsPassedMatch[1]} 項測試通過` : `全部 ${allTestsPassedMatch[1]} 项测试通过`;
  }
  const passedFailedMatch = text.match(/^(\d+)\/(\d+)\s+passed,\s+(\d+)\s+failed$/i);
  if (passedFailedMatch) {
    return isTw
      ? `${passedFailedMatch[1]}/${passedFailedMatch[2]} 項通過，${passedFailedMatch[3]} 項失敗`
      : `${passedFailedMatch[1]}/${passedFailedMatch[2]} 项通过，${passedFailedMatch[3]} 项失败`;
  }
  const cooldownClearedMatch = text.match(/^Cooldown\s+cleared\s+for\s+(.+)$/i);
  if (cooldownClearedMatch) {
    return isTw ? `已清除 ${cooldownClearedMatch[1]} 的冷卻` : `已清除 ${cooldownClearedMatch[1]} 的冷却`;
  }
  const deletedConnsFailedMatch = text.match(/^Deleted\s+(\d+)\s+connection\(s\),\s*(\d+)\s+failed\.$/i);
  if (deletedConnsFailedMatch) {
    return isTw
      ? `已刪除 ${deletedConnsFailedMatch[1]} 個連線，${deletedConnsFailedMatch[2]} 個失敗。`
      : `已删除 ${deletedConnsFailedMatch[1]} 个连接，${deletedConnsFailedMatch[2]} 个失败。`;
  }
  const deletedFailuresMatch = text.match(/^Deleted\s+with\s+(\d+)\s+failures?\.$/i);
  if (deletedFailuresMatch) {
    return isTw ? `刪除完成，其中 ${deletedFailuresMatch[1]} 個失敗。` : `删除完成，其中 ${deletedFailuresMatch[1]} 个失败。`;
  }
  const successfullyAddedModelsMatch = text.match(/^Successfully\s+added\s+(\d+)\s+models$/i);
  if (successfullyAddedModelsMatch) {
    return isTw ? `成功新增 ${successfullyAddedModelsMatch[1]} 個模型` : `成功添加 ${successfullyAddedModelsMatch[1]} 个模型`;
  }
  const cannotDeletePoolMatch = text.match(/^Cannot\s+delete:\s*(\d+)\s+connection\(s\)\s+are\s+still\s+using\s+this\s+pool\.$/i);
  if (cannotDeletePoolMatch) {
    return isTw
      ? `無法刪除：仍有 ${cannotDeletePoolMatch[1]} 個連線正在使用此代理池。`
      : `无法删除：仍有 ${cannotDeletePoolMatch[1]} 个连接正在使用此代理池。`;
  }
  const healthCheckDoneMatch = text.match(/^Health\s+check\s+done\.\s+Alive:\s*(\d+),\s*Dead:\s*(\d+)$/i);
  if (healthCheckDoneMatch) {
    return isTw
      ? `健康檢查完成。存活: ${healthCheckDoneMatch[1]}，失效: ${healthCheckDoneMatch[2]}`
      : `健康检查完成。存活: ${healthCheckDoneMatch[1]}，失效: ${healthCheckDoneMatch[2]}`;
  }
  const deployedUrlMatch = text.match(/^Deployed:\s*(https?:\/\/.+)$/i);
  if (deployedUrlMatch) {
    return isTw ? `部署成功: ${deployedUrlMatch[1]}` : `部署成功: ${deployedUrlMatch[1]}`;
  }
  const disabledDeadProxiesMatch = text.match(/^Disabled\s+(\d+)\s+dead\s+proxies$/i);
  if (disabledDeadProxiesMatch) {
    return isTw ? `已停用 ${disabledDeadProxiesMatch[1]} 個無效代理` : `已禁用 ${disabledDeadProxiesMatch[1]} 个失效代理`;
  }
  const batchImportResultMatch = text.match(/^Batch\s+import\s+completed:\s+Created\s+(\d+),\s*Skipped\s+(\d+),\s*Failed\s+(\d+)$/i);
  if (batchImportResultMatch) {
    return isTw
      ? `批次匯入完成：建立 ${batchImportResultMatch[1]}，略過 ${batchImportResultMatch[2]}，失敗 ${batchImportResultMatch[3]}`
      : `批量导入完成：创建 ${batchImportResultMatch[1]}，跳过 ${batchImportResultMatch[2]}，失败 ${batchImportResultMatch[3]}`;
  }

  // 25. 动态删除确认弹窗 "Delete combo <name>?"
  const deleteComboMatch = text.match(/^Delete\s+combo\s+"(.+?)"\?$/i);
  if (deleteComboMatch) {
    return isTw ? `刪除組合 "${deleteComboMatch[1]}"？` : `删除组合 "${deleteComboMatch[1]}"？`;
  }

  // 26. 组合生成与预览动态提示
  const noModelsToGenMatch = text.match(/^No\s+(.+?)\s+models\s+available\s+to\s+generate\.$/i);
  if (noModelsToGenMatch) {
    return isTw
      ? `沒有可用於產生的 ${noModelsToGenMatch[1]} 模型。`
      : `没有可用于生成的 ${noModelsToGenMatch[1]} 模型。`;
  }
  const allCombosExistMatch = text.match(/^All\s+(\d+)\s+(.+?)\s+combos\s+already\s+exist\.\s+Nothing\s+to\s+create\.$/i);
  if (allCombosExistMatch) {
    return isTw
      ? `全部 ${allCombosExistMatch[1]} 個 ${allCombosExistMatch[2]} 組合已存在。無需建立。`
      : `全部 ${allCombosExistMatch[1]} 个 ${allCombosExistMatch[2]} 组合已存在。无需创建。`;
  }
  const failedToGenMatch = text.match(/^Failed\s+to\s+generate\s+(.+)$/i);
  if (failedToGenMatch) {
    return isTw ? `產生 ${failedToGenMatch[1]} 失敗` : `生成 ${failedToGenMatch[1]} 失败`;
  }
  const failedToPreviewMatch = text.match(/^Failed\s+to\s+preview\s+(.+)$/i);
  if (failedToPreviewMatch) {
    return isTw ? `預覽 ${failedToPreviewMatch[1]} 失敗` : `预览 ${failedToPreviewMatch[1]} 失败`;
  }

  // 27. 自定义请求头校验动态提示
  const invalidHeaderMatch = text.match(/^Invalid\s+header\s+name:\s*(.+)$/i);
  if (invalidHeaderMatch) {
    return isTw ? `無效的請求頭名稱：${invalidHeaderMatch[1]}` : `无效的请求头名称：${invalidHeaderMatch[1]}`;
  }
  const headerNoOverrideMatch = text.match(/^Header\s+(.+?)\s+cannot\s+be\s+overridden$/i);
  if (headerNoOverrideMatch) {
    return isTw ? `請求頭 ${headerNoOverrideMatch[1]} 無法被覆寫` : `请求头 ${headerNoOverrideMatch[1]} 无法被覆盖`;
  }
  const dupHeaderMatch = text.match(/^Duplicate\s+header\s+name:\s*(.+)$/i);
  if (dupHeaderMatch) {
    return isTw ? `重複的請求頭名稱：${dupHeaderMatch[1]}` : `重复的请求头名称：${dupHeaderMatch[1]}`;
  }

  // 28. 连接更新失败动态提示
  const updatedFailedReqsMatch = text.match(/^Updated\s+with\s+(\d+)\s+failed\s+request\(s\)\.$/i);
  if (updatedFailedReqsMatch) {
    return isTw
      ? `更新完成，其中 ${updatedFailedReqsMatch[1]} 個請求失敗。`
      : `更新完成，其中 ${updatedFailedReqsMatch[1]} 个请求失败。`;
  }

  // 29. 独立单词 combo / Combo
  if (text.toLowerCase() === "combo") {
    return isTw ? "組合" : "组合";
  }

  // 30. 服务类型全大写标签
  const upperKindMap = {
    "WEBSEARCH": isTw ? "網頁搜尋" : "网页搜索",
    "WEBFETCH": isTw ? "網頁抓取" : "网页抓取",
    "EMBEDDING": "嵌入",
    "TTS": isTw ? "文字轉語音" : "文本转语音",
    "STT": isTw ? "語音轉文字" : "语音转文本",
    "SYSTEMONE": "System One",
    "IMAGETOTEXT": isTw ? "影像轉文字" : "图像转文本",
    "IMAGE": isTw ? "影像" : "图像",
    "VIDEO": isTw ? "影片" : "视频",
    "MUSIC": isTw ? "音樂" : "音乐",
  };
  const upperTrimmed = text.toUpperCase();
  if (upperKindMap[upperTrimmed]) {
    return upperKindMap[upperTrimmed];
  }

  // 31. 自定义节点标签 "Custom · <prefix>"
  const customPrefixMatch = text.match(/^Custom\s*·\s*(.+)$/i);
  if (customPrefixMatch) {
    return isTw ? `自訂 · ${customPrefixMatch[1]}` : `自定义 · ${customPrefixMatch[1]}`;
  }

  // 32. 模型卡片标题 "Models — <kind>"
  const modelsKindMatch = text.match(/^Models\s*(?:—|-)\s*(.+)$/i);
  if (modelsKindMatch) {
    const rawKind = modelsKindMatch[1].trim();
    const mappedKind = upperKindMap[rawKind.toUpperCase()] || rawKind;
    return isTw ? `模型 — ${mappedKind}` : `模型 — ${mappedKind}`;
  }

  // 33. Google Search Grounding 与 AI Studio 免费层提示
  if (text.includes("Google Search grounding through an Antigravity OAuth account")) {
    return isTw
      ? "免費 —— 透過 Antigravity OAuth 帳戶使用 Google Search Grounding。"
      : "免费 —— 通过 Antigravity OAuth 账户使用 Google Search Grounding。";
  }
  const freeTierTokensMatch = text.match(/^Free\s+tier:\s*(\d+)\s+RPM,\s*([0-9a-zA-Z.]+)\s+tokens\/day\s+on\s+(.+?)\s+via\s+AI\s+Studio\.$/i);
  if (freeTierTokensMatch) {
    return isTw
      ? `免費層：透過 AI Studio 使用 ${freeTierTokensMatch[3]} 每分鐘 ${freeTierTokensMatch[1]} 次請求，每天 ${freeTierTokensMatch[2]} Token。`
      : `免费层：通过 AI Studio 使用 ${freeTierTokensMatch[3]} 每分钟 ${freeTierTokensMatch[1]} 次请求，每天 ${freeTierTokensMatch[2]} Token。`;
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

/**
 * 把当前应用语言同步到 `<html lang>`。
 *
 * 为何在客户端做、而不是让根布局 SSR 直接吐对：布局是服务端组件，而语言来自
 * 壳层注入的 cookie，读它就得用 `cookies()` → 整个 `/dashboard` 从静态预渲染
 * 被拉成动态渲染；而且**首启那次仍读不到**（cookie 由 document-start 脚本写，
 * 晚于 HTTP 响应到达）。代价与收益不成比例，故就地校正（ADR 0008 的已知取舍）。
 *
 * 静态 HTML 里的 `lang="en"` 是回退值（= DEFAULT_LOCALE），不是错误。
 */
function applyDocumentLang() {
  if (typeof document === "undefined") return;
  try {
    document.documentElement.lang = currentLocale;
  } catch {
    /* 忽略 */
  }
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
  const current = node.nodeValue;
  if (!current || !current.trim()) return;

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

  // 跳过 Material Symbols 与 Material Icons 图标字体节点，防止图标名称被翻译
  const classList = parent.classList;
  if (
    classList &&
    (classList.contains("material-symbols-outlined") ||
      classList.contains("material-symbols-rounded") ||
      classList.contains("material-symbols-sharp") ||
      classList.contains("material-icons"))
  ) {
    return;
  }

  // React reuses text nodes and rewrites their value on re-render (a
  // characterData mutation, no childList event). When the current value is
  // neither our last translation nor the recorded original, it is fresh
  // source text — re-capture it as the new original before translating.
  const isOurTranslation = (node._translated != null && current === node._translated) || (node._i18nApplied != null && current === node._i18nApplied);
  const isSameAsOriginal = current === node._originalText;
  if (!isOurTranslation && !isSameAsOriginal) {
    node._originalText = current;
  }
  if (node._originalText == null) node._originalText = current;

  // Translate from the recorded original so locale switches stay idempotent
  const translated = translate(node._originalText);
  node._translated = translated;
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
  processElementAriaLabels(element);
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

/**
 * 翻译元素上的 aria-label 属性
 * @param {Element} element 目标 DOM 节点
 */
function processAriaLabel(element) {
  if (!element?.getAttribute) return;
  if (element.closest?.("[data-i18n-skip]")) return;
  const current = element.getAttribute("aria-label");
  if (!current) return;
  if (element._i18nOrigAriaLabel === undefined) {
    element._i18nOrigAriaLabel = current;
  }
  const orig = element._i18nOrigAriaLabel;
  const translated = translate(orig);
  if (element.getAttribute("aria-label") !== translated) {
    element.setAttribute("aria-label", translated);
  }
}

/**
 * 遍历并翻译元素内的所有带 aria-label 的属性节点
 * @param {Element} element 根容器节点
 */
function processElementAriaLabels(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
  processAriaLabel(element);
  element.querySelectorAll?.("[aria-label]").forEach(processAriaLabel);
}

// Initialize runtime i18n
export async function initRuntimeI18n() {
  if (typeof window === "undefined") return;
  
  currentLocale = getLocaleFromCookie();
  applyDocumentLang();
  await loadTranslations(currentLocale);

  // 挂钩原生 alert 与 confirm，使其弹窗提示文本自动翻译
  if (!window.__i18n_dialog_patched) {
    window.__i18n_dialog_patched = true;
    const origAlert = window.alert;
    if (typeof origAlert === "function") {
      window.alert = function (message) {
        return origAlert.call(this, typeof message === "string" ? translate(message) : message);
      };
    }
    const origConfirm = window.confirm;
    if (typeof origConfirm === "function") {
      window.confirm = function (message) {
        return origConfirm.call(this, typeof message === "string" ? translate(message) : message);
      };
    }
  }
  
  // Process existing DOM
  processElement(document.body);
  
  // Watch for new nodes AND in-place text rewrites. React reuses text nodes on
  // re-render (only nodeValue changes → a characterData mutation with no
  // childList event), so observing childList alone leaves later-updated labels
  // untranslated.
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      // React re-renders reset title / placeholder attributes — re-translate on change
      if (mutation.type === "attributes") {
        if (mutation.attributeName === "title") {
          processTitle(mutation.target);
        } else if (mutation.attributeName === "placeholder") {
          processPlaceholder(mutation.target);
        } else if (mutation.attributeName === "aria-label") {
          processAriaLabel(mutation.target);
        }
        return;
      }
      // React re-renders mutate text node values in place — re-translate on characterData change
      if (mutation.type === "characterData") {
        const node = mutation.target;
        // Skip if this change was made by our own translation to avoid infinite loops
        if (node._translated === node.nodeValue || node._i18nApplied === node.nodeValue) return;
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
    attributeFilter: ["title", "placeholder", "aria-label"],
  });
}

// Reload translations when locale changes
export async function reloadTranslations() {
  currentLocale = getLocaleFromCookie();
  applyDocumentLang();
  await loadTranslations(currentLocale);
  
  // Notify all registered callbacks
  reloadCallbacks.forEach(callback => callback());
  
  // Re-process entire DOM (will use stored original text)
  processElement(document.body);
}
