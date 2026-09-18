"use client";

import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import { Card, Button, Toggle, Input, Select } from "@/shared/components";
import PricingModal from "@/shared/components/PricingModal";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG } from "@/shared/constants/config";
import { translate, reloadTranslations } from "@/i18n/runtime";
import { LOCALE_COOKIE, normalizeLocale } from "@/i18n/config";

function getLocaleFromCookie() {
  if (typeof document === "undefined") return "en";
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : "en";
  return normalizeLocale(value);
}

/**
 * 解析系统宿主当前语言代码
 * @return {string} 规范化后的语言代码 ('en' | 'zh-CN' | 'zh-TW')
 */
function resolveSystemLocale() {
  if (typeof navigator === "undefined") return "en";
  const navLang = (navigator.language || navigator.userLanguage || "en").toLowerCase();
  if (navLang.includes("tw") || navLang.includes("hk") || navLang.includes("hant")) {
    return "zh-TW";
  }
  if (navLang.startsWith("zh")) {
    return "zh-CN";
  }
  return "en";
}

export default function ProfilePage() {
  const { copied, copy } = useCopyToClipboard();
  const [pricingOpen, setPricingOpen] = useState(false);
  const [settings, setSettings] = useState({ fallbackStrategy: "fill-first" });
  const [loading, setLoading] = useState(true);
  const [passwords, setPasswords] = useState({ current: "", new: "", confirm: "" });
  const [passStatus, setPassStatus] = useState({ type: "", message: "" });
  const [passLoading, setPassLoading] = useState(false);
  const [oidcForm, setOidcForm] = useState({
    authMode: "password",
    oidcIssuerUrl: "",
    oidcClientId: "",
    oidcScopes: "openid profile email",
    oidcLoginLabel: "Sign in with OIDC",
  });
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [oidcStatus, setOidcStatus] = useState({ type: "", message: "" });
  const [oidcLoading, setOidcLoading] = useState(false);
  const [oidcTestLoading, setOidcTestLoading] = useState(false);
  const [oidcTestStatus, setOidcTestStatus] = useState({ type: "", message: "" });
  const [oidcExpanded, setOidcExpanded] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const oidcRedirectUri = origin ? `${origin}/api/auth/oidc/callback` : "/api/auth/oidc/callback";

  // 语言与主题的**切换入口**已挪到壳层设置面板（/settings，Cmd+,）。
  // 这里保留挂载时的偏好恢复：偏好存 localStorage，若 cookie 与它不一致
  //（刚在 /settings 改过、或换了浏览器 profile），就地同步一次。
  useEffect(() => {
    let saved = "system";
    try {
      saved = localStorage.getItem("irouter_locale_preference") || "system";
    } catch {}
    const targetLocale = saved === "system" ? resolveSystemLocale() : saved;
    if (getLocaleFromCookie() !== targetLocale) {
      document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(targetLocale)}; path=/; max-age=31536000`;
      fetch("/api/locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: targetLocale }),
      }).catch(() => {});
      reloadTranslations();
    }
  }, []);
  const samlAcsUrl = origin ? `${origin}/api/auth/saml/acs` : "/api/auth/saml/acs";
  const samlMetadataUrl = origin ? `${origin}/api/auth/saml/metadata` : "/api/auth/saml/metadata";
  
  // SAML State
  const [ssoTypeTab, setSsoTypeTab] = useState("saml");
  const [samlForm, setSamlForm] = useState({
    samlEntryPoint: "",
    samlIssuer: "urn:9router:sp",
    samlCert: "",
    samlLoginLabel: "Sign in with SAML SSO",
    samlAttributeEmail: "email",
    samlAttributeName: "name",
  });
  const [samlStatus, setSamlStatus] = useState({ type: "", message: "" });
  const [samlLoading, setSamlLoading] = useState(false);
  const [samlTestLoading, setSamlTestLoading] = useState(false);
  const [samlTestStatus, setSamlTestStatus] = useState({ type: "", message: "" });
  const [showSamlGuide, setShowSamlGuide] = useState(false);
  const idpMetadataFileRef = useRef(null);
  const certFileRef = useRef(null);

  const [proxyForm, setProxyForm] = useState({
    outboundProxyEnabled: false,
    outboundProxyUrl: "",
    outboundNoProxy: "",
  });
  const [proxyStatus, setProxyStatus] = useState({ type: "", message: "" });
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxyTestLoading, setProxyTestLoading] = useState(false);

  // 是否远程访问：环境探测（window.location）→ useSyncExternalStore，
  // 首屏给 false（服务端无 window），水合后切真值。
  // 不用 useEffect+setState：本仓 react-hooks/set-state-in-effect 是 error。
  const isRemoteHost = useSyncExternalStore(
    () => () => {},
    () => !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname),
    () => false,
  );

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        setSettings(data);
        setOidcForm({
          authMode: data?.authMode || "password",
          oidcIssuerUrl: data?.oidcIssuerUrl || "",
          oidcClientId: data?.oidcClientId || "",
          oidcScopes: data?.oidcScopes || "openid profile email",
          oidcLoginLabel: data?.oidcLoginLabel || "Sign in with OIDC",
        });
        setOidcClientSecret("");
        setSsoTypeTab(data?.ssoType || "saml");
        setSamlForm({
          samlEntryPoint: data?.samlEntryPoint || "",
          samlIssuer: data?.samlIssuer || "urn:9router:sp",
          samlCert: data?.samlCert || "",
          samlLoginLabel: data?.samlLoginLabel || "Sign in with SAML SSO",
          samlAttributeEmail: data?.samlAttributeEmail || "email",
          samlAttributeName: data?.samlAttributeName || "name",
        });
        if (
          data?.authMode === "sso" ||
          data?.authMode === "saml" ||
          data?.authMode === "oidc" ||
          data?.authMode === "both"
        ) {
          setOidcExpanded(true);
        }
        setProxyForm({
          outboundProxyEnabled: data?.outboundProxyEnabled === true,
          outboundProxyUrl: data?.outboundProxyUrl || "",
          outboundNoProxy: data?.outboundNoProxy || "",
        });
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch settings:", err);
        setLoading(false);
      });
  }, []);

  const updateOutboundProxy = async (e) => {
    e.preventDefault();
    if (settings.outboundProxyEnabled !== true) return;
    setProxyLoading(true);
    setProxyStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outboundProxyUrl: proxyForm.outboundProxyUrl,
          outboundNoProxy: proxyForm.outboundNoProxy,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setProxyStatus({ type: "success", message: "Proxy settings applied" });
      } else {
        setProxyStatus({ type: "error", message: data.error || "Failed to update proxy settings" });
      }
    } catch (err) {
      setProxyStatus({ type: "error", message: "An error occurred" });
    } finally {
      setProxyLoading(false);
    }
  };

  const testOutboundProxy = async () => {
    if (settings.outboundProxyEnabled !== true) return;

    const proxyUrl = (proxyForm.outboundProxyUrl || "").trim();
    if (!proxyUrl) {
      setProxyStatus({ type: "error", message: "Please enter a Proxy URL to test" });
      return;
    }

    setProxyTestLoading(true);
    setProxyStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings/proxy-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyUrl }),
      });

      const data = await res.json();
      if (res.ok && data?.ok) {
        setProxyStatus({
          type: "success",
          message: `Proxy test OK (${data.status}) in ${data.elapsedMs}ms`,
        });
      } else {
        setProxyStatus({
          type: "error",
          message: data?.error || "Proxy test failed",
        });
      }
    } catch (err) {
      setProxyStatus({ type: "error", message: "An error occurred" });
    } finally {
      setProxyTestLoading(false);
    }
  };

  const updateOutboundProxyEnabled = async (outboundProxyEnabled) => {
    setProxyLoading(true);
    setProxyStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outboundProxyEnabled }),
      });

      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setProxyForm((prev) => ({ ...prev, outboundProxyEnabled: data?.outboundProxyEnabled === true }));
        setProxyStatus({
          type: "success",
          message: outboundProxyEnabled ? "Proxy enabled" : "Proxy disabled",
        });
      } else {
        setProxyStatus({ type: "error", message: data.error || "Failed to update proxy settings" });
      }
    } catch (err) {
      setProxyStatus({ type: "error", message: "An error occurred" });
    } finally {
      setProxyLoading(false);
    }
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    if (passwords.new !== passwords.confirm) {
      setPassStatus({ type: "error", message: "Passwords do not match" });
      return;
    }

    setPassLoading(true);
    setPassStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: passwords.current,
          newPassword: passwords.new,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setPassStatus({ type: "success", message: "Password updated successfully" });
        setPasswords({ current: "", new: "", confirm: "" });
      } else {
        setPassStatus({ type: "error", message: translate(data.error || "Failed to update password") });
      }
    } catch (err) {
      setPassStatus({ type: "error", message: "An error occurred" });
    } finally {
      setPassLoading(false);
    }
  };

  const updateFallbackStrategy = async (strategy) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fallbackStrategy: strategy }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, fallbackStrategy: strategy }));
      }
    } catch (err) {
      console.error("Failed to update settings:", err);
    }
  };

  const updateComboStrategy = async (strategy) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboStrategy: strategy }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, comboStrategy: strategy }));
      }
    } catch (err) {
      console.error("Failed to update combo strategy:", err);
    }
  };

  // 自维护特性（ADR 0003）：effort-aware 路由全局默认开关
  const updateEffortAwareRoute = async (enabled) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ effortAwareRoute: enabled }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, effortAwareRoute: enabled }));
      }
    } catch (err) {
      console.error("Failed to update effort-aware route:", err);
    }
  };

  // 自动重试（自维护特性，ADR 0003）：局部更新 settings.autoRetry
  const updateAutoRetry = (patch) => {
    const next = { ...(settings.autoRetry || {}), ...patch };
    setSettings(prev => ({ ...prev, autoRetry: next }));
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoRetry: next }),
    }).catch(err => console.error("Failed to update auto retry:", err));
  };

  const updateStickyLimit = async (limit) => {
    const numLimit = parseInt(limit);
    if (isNaN(numLimit) || numLimit < 1) return;

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stickyRoundRobinLimit: numLimit }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, stickyRoundRobinLimit: numLimit }));
      }
    } catch (err) {
      console.error("Failed to update sticky limit:", err);
    }
  };

  const updateComboStickyLimit = async (limit) => {
    const numLimit = parseInt(limit);
    if (isNaN(numLimit) || numLimit < 1) return;

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboStickyRoundRobinLimit: numLimit }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, comboStickyRoundRobinLimit: numLimit }));
      }
    } catch (err) {
      console.error("Failed to update combo sticky limit:", err);
    }
  };

  const updateRequireLogin = async (requireLogin) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireLogin }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, requireLogin }));
      }
    } catch (err) {
      console.error("Failed to update require login:", err);
    }
  };

  const updateOidcForm = (field, value) => {
    setOidcForm((prev) => ({ ...prev, [field]: value }));
  };

  const saveOidcSettings = async (authMode = oidcForm.authMode || "password") => {
    const issuerUrl = oidcForm.oidcIssuerUrl.trim();
    const clientId = oidcForm.oidcClientId.trim();
    const scopes = oidcForm.oidcScopes.trim();
    const loginLabel = oidcForm.oidcLoginLabel.trim();
    const secret = oidcClientSecret.trim();

    if (authMode !== "password" && (!issuerUrl || !clientId || !secret) && !settings.oidcConfigured) {
      setOidcStatus({ type: "error", message: "Issuer URL, client ID, and client secret are required to enable OIDC." });
      return;
    }

    setOidcLoading(true);
    setOidcStatus({ type: "", message: "" });
    setOidcTestStatus({ type: "", message: "" });

    try {
      const payload = {
        authMode,
        ssoType: "oidc",
        oidcIssuerUrl: issuerUrl,
        oidcClientId: clientId,
        oidcScopes: scopes || "openid profile email",
        oidcLoginLabel: loginLabel || "Sign in with OIDC",
      };
      if (secret) {
        payload.oidcClientSecret = secret;
      }

      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setOidcForm({
          authMode: data?.authMode || authMode,
          oidcIssuerUrl: data?.oidcIssuerUrl || issuerUrl,
          oidcClientId: data?.oidcClientId || clientId,
          oidcScopes: data?.oidcScopes || scopes || "openid profile email",
          oidcLoginLabel: data?.oidcLoginLabel || loginLabel || "Sign in with OIDC",
        });
        setOidcClientSecret("");
        setOidcStatus({
          type: "success",
          message:
            authMode === "oidc"
              ? "OIDC login enabled"
              : authMode === "both"
                ? "Password and OIDC login enabled"
                : "OIDC settings saved",
        });
      } else {
        setOidcStatus({ type: "error", message: data.error || "Failed to save OIDC settings" });
      }
    } catch (err) {
      setOidcStatus({ type: "error", message: "An error occurred" });
    } finally {
      setOidcLoading(false);
    }
  };

  const testOidcConnection = async () => {
    const issuerUrl = oidcForm.oidcIssuerUrl.trim();
    const clientId = oidcForm.oidcClientId.trim();
    const scopes = oidcForm.oidcScopes.trim();
    const secret = oidcClientSecret.trim();

    if (!issuerUrl || !clientId) {
      setOidcTestStatus({ type: "error", message: "Issuer URL and client ID are required to test the connection." });
      return;
    }

    setOidcTestLoading(true);
    setOidcStatus({ type: "", message: "" });
    setOidcTestStatus({ type: "", message: "" });

    try {
      const saveRes = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authMode: oidcForm.authMode || settings.authMode || "password",
          oidcIssuerUrl: issuerUrl,
          oidcClientId: clientId,
          oidcScopes: scopes || "openid profile email",
          oidcLoginLabel: oidcForm.oidcLoginLabel.trim() || "Sign in with OIDC",
          ...(secret ? { oidcClientSecret: secret } : {}),
        }),
      });

      const saved = await saveRes.json().catch(() => ({}));
      if (!saveRes.ok) {
        setOidcTestStatus({
          type: "error",
          message: saved.error || "Failed to save OIDC settings before testing",
        });
        return;
      }

      const res = await fetch("/api/auth/oidc/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issuerUrl: saved.oidcIssuerUrl || issuerUrl,
          clientId: saved.oidcClientId || clientId,
          scopes: saved.oidcScopes || scopes || "openid profile email",
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        const statusMessage = data.clientSecretTested
          ? data.clientSecretValid === true
            ? `Connection OK. Discovery loaded from ${data.issuerUrl}. Client secret validated too.`
            : `Connection OK. Discovery loaded from ${data.issuerUrl}. Client secret was not checked.`
          : `Connection OK. Discovery loaded from ${data.issuerUrl}.`;
        setOidcTestStatus({
          type: "success",
          message: statusMessage,
        });
      } else {
        setOidcTestStatus({ type: "error", message: data.error || "OIDC connection test failed" });
      }
    } catch (err) {
      setOidcTestStatus({ type: "error", message: "An error occurred" });
    } finally {
      setOidcTestLoading(false);
    }
  };

  const updateSamlForm = (field, value) => {
    setSamlForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleIdpMetadataUpload = (event) => {
    const file = event.target.files?.[0];
    if (idpMetadataFileRef.current) idpMetadataFileRef.current.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const xmlText = e.target?.result || "";
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, "text/xml");
        const parserError = doc.querySelector("parsererror");
        if (parserError) {
          setSamlStatus({ type: "error", message: "Unable to parse valid SAML IdP metadata from XML file" });
          return;
        }

        const entityID = doc.documentElement.getAttribute("entityID") || "";
        const ssoNodes = Array.from(doc.querySelectorAll("SingleSignOnService, *|SingleSignOnService"));
        let ssoUrl = "";
        for (const node of ssoNodes) {
          const binding = node.getAttribute("Binding") || "";
          const location = node.getAttribute("Location") || "";
          if (location) {
            ssoUrl = location;
            if (binding.includes("HTTP-Redirect")) break;
          }
        }

        const certNodes = Array.from(doc.querySelectorAll("X509Certificate, *|X509Certificate"));
        let certStr = "";
        if (certNodes.length > 0) {
          certStr = certNodes[0].textContent.trim();
        }

        setSamlForm((prev) => ({
          ...prev,
          samlEntryPoint: ssoUrl || prev.samlEntryPoint,
          samlIssuer: prev.samlIssuer || "urn:9router:sp",
          samlCert: certStr || prev.samlCert,
        }));

        setSamlStatus({
          type: "success",
          message: `IdP Metadata imported! (SSO URL: ${ssoUrl ? "found" : "not found"}, EntityID: ${entityID ? "found" : "not found"}, Cert: ${certStr ? "found" : "not found"})`,
        });
      } catch (err) {
        setSamlStatus({ type: "error", message: "Error reading IdP Metadata XML file" });
      }
    };
    reader.readAsText(file);
  };

  const handleCertFileUpload = (event) => {
    const file = event.target.files?.[0];
    if (certFileRef.current) certFileRef.current.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result || "";
      setSamlForm((prev) => ({ ...prev, samlCert: text.trim() }));
      setSamlStatus({ type: "success", message: "Certificate file loaded into configuration." });
    };
    reader.readAsText(file);
  };

  const saveSamlSettings = async (targetAuthMode = oidcForm.authMode || "password") => {
    setSamlLoading(true);
    setSamlStatus({ type: "", message: "" });
    setSamlTestStatus({ type: "", message: "" });

    try {
      const payload = {
        authMode: targetAuthMode,
        ssoType: "saml",
        samlEntryPoint: samlForm.samlEntryPoint.trim(),
        samlIssuer: samlForm.samlIssuer.trim() || "urn:9router:sp",
        samlCert: samlForm.samlCert.trim(),
        samlLoginLabel: samlForm.samlLoginLabel.trim() || "Sign in with SAML SSO",
        samlAttributeEmail: samlForm.samlAttributeEmail.trim() || "email",
        samlAttributeName: samlForm.samlAttributeName.trim() || "name",
      };

      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setSamlForm({
          samlEntryPoint: data?.samlEntryPoint || payload.samlEntryPoint,
          samlIssuer: data?.samlIssuer || payload.samlIssuer,
          samlCert: data?.samlCert || payload.samlCert,
          samlLoginLabel: data?.samlLoginLabel || payload.samlLoginLabel,
          samlAttributeEmail: data?.samlAttributeEmail || payload.samlAttributeEmail,
          samlAttributeName: data?.samlAttributeName || payload.samlAttributeName,
        });
        setSamlStatus({
          type: "success",
          message:
            targetAuthMode === "sso" || targetAuthMode === "saml"
              ? "SAML SSO login enabled"
              : targetAuthMode === "both"
                ? "Password and SAML SSO login enabled"
                : "SAML 2.0 settings saved",
        });
      } else {
        setSamlStatus({ type: "error", message: data.error || "Failed to save SAML settings" });
      }
    } catch {
      setSamlStatus({ type: "error", message: "An error occurred while saving SAML settings" });
    } finally {
      setSamlLoading(false);
    }
  };

  const testSamlConnection = async () => {
    setSamlTestLoading(true);
    setSamlStatus({ type: "", message: "" });
    setSamlTestStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/auth/saml/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          samlEntryPoint: samlForm.samlEntryPoint.trim(),
          samlIssuer: samlForm.samlIssuer.trim(),
          samlCert: samlForm.samlCert.trim(),
        }),
      });

      const data = await res.json();
      if (res.ok && data.ok) {
        setSamlTestStatus({ type: "success", message: data.message || "SAML configuration verified!" });
      } else {
        setSamlTestStatus({ type: "error", message: data.error || "SAML configuration test failed" });
      }
    } catch {
      setSamlTestStatus({ type: "error", message: "An error occurred while testing SAML configuration" });
    } finally {
      setSamlTestLoading(false);
    }
  };

  const updateObservabilityEnabled = async (enabled) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enableObservability: enabled }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, enableObservability: enabled }));
      }
    } catch (err) {
      console.error("Failed to update enableObservability:", err);
    }
  };

  const updateVerboseErrorLog = async (enabled) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verboseErrorLog: enabled }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, verboseErrorLog: enabled }));
      }
    } catch (err) {
      console.error("Failed to update verboseErrorLog:", err);
    }
  };

  // 请求脱敏（ADR 0005）：4 个字段共用一个 PATCH 助手
  const updateDlpSetting = async (patch) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) setSettings(prev => ({ ...prev, ...patch }));
    } catch (err) {
      console.error("Failed to update DLP settings:", err);
    }
  };
  const observabilityEnabled = settings.enableObservability === true;
  const verboseErrorLog = settings.verboseErrorLog === true;
  const dlpMode = settings.dlpMode || "off";
  const dlpKnownSecrets = settings.dlpKnownSecrets !== false;
  const dlpAllowExemptions = settings.dlpAllowExemptions === true;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-0">
      <div className="flex flex-col gap-6">
        {/* Security */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
              <span className="material-symbols-outlined text-[20px]">shield</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">Security</h3>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Require login</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  When ON, dashboard requires password. When OFF, access without login.
                </p>
              </div>
              <Toggle
                checked={settings.requireLogin === true}
                onChange={() => updateRequireLogin(!settings.requireLogin)}
                disabled={loading}
              />
            </div>
            {settings.requireLogin === true && (
              <form onSubmit={handlePasswordChange} className="flex flex-col gap-4 pt-4 border-t border-border/50">
                {settings.hasPassword && (
                  <div className="flex flex-col gap-2">
                    <label className="text-xs sm:text-sm font-medium">Current Password</label>
                    <Input
                      type="password"
                      placeholder="Enter current password"
                      value={passwords.current}
                      onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
                      required
                    />
                  </div>
                )}
                {/* {!settings.hasPassword && (
                  <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                    <p className="text-sm text-blue-600 dark:text-blue-400">
                      Setting password for the first time. Leave current password empty or use default: <code className="bg-blue-500/20 px-1 rounded">123456</code>
                    </p>
                  </div>
                )} */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <label className="text-xs sm:text-sm font-medium">New Password</label>
                    <Input
                      type="password"
                      placeholder="Enter new password"
                      value={passwords.new}
                      onChange={(e) => setPasswords({ ...passwords, new: e.target.value })}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-xs sm:text-sm font-medium">Confirm New Password</label>
                    <Input
                      type="password"
                      placeholder="Confirm new password"
                      value={passwords.confirm}
                      onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })}
                      required
                    />
                  </div>
                </div>

                {passStatus.message && (
                  <p className={`text-xs sm:text-sm ${passStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                    {passStatus.message}
                  </p>
                )}

                <div className="pt-2">
                  <Button type="submit" variant="primary" loading={passLoading} className="w-full sm:w-auto">
                    {settings.hasPassword ? "Update Password" : "Set Password"}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </Card>

        {/* Single Sign-On (SSO) */}
        <Card>
          <button
            type="button"
            onClick={() => setOidcExpanded((v) => !v)}
            className="w-full flex items-center gap-3 text-left"
          >
            <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">lock_open</span>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-base sm:text-lg font-semibold">Single Sign-On (SSO)</h3>
              {/* Full sentences, not interpolated fragments: the dictionaries key
                  on whole strings, and a bare "active" key would collide with the
                  existing Active/Inactive status badge wording. */}
              <p className="text-xs text-text-muted">
                {settings.authMode === "sso" || settings.authMode === "oidc" || settings.authMode === "saml"
                  ? settings.ssoType === "saml"
                    ? "SAML 2.0 SSO active"
                    : "OIDC SSO active"
                  : settings.authMode === "both"
                    ? settings.ssoType === "saml"
                      ? "Password + SAML 2.0 active"
                      : "Password + OIDC active"
                    : "Optional SSO via Okta, Entra ID, Keycloak, or OIDC"}
              </p>
            </div>
            <span className="material-symbols-outlined text-text-muted shrink-0">
              {oidcExpanded ? "expand_less" : "expand_more"}
            </span>
          </button>
          {oidcExpanded && (
            <div className="flex flex-col gap-4 mt-4">
              <p className="text-xs sm:text-sm text-text-muted">
                Configure enterprise Single Sign-On (SSO) for dashboard access using SAML 2.0 or OIDC.
              </p>

              {/* SSO Protocol Switcher Tabs */}
              <div className="flex flex-col gap-2">
                <label className="font-medium text-sm sm:text-base">SSO Protocol</label>
                <div className="flex p-1 rounded-lg bg-black/5 dark:bg-white/5 border border-border">
                  <button
                    type="button"
                    onClick={() => setSsoTypeTab("saml")}
                    className={cn(
                      "flex-1 py-1.5 px-3 rounded-md font-medium text-xs sm:text-sm transition-all text-center",
                      ssoTypeTab === "saml"
                        ? "bg-white dark:bg-white/10 text-text-main shadow-sm"
                        : "text-text-muted hover:text-text-main"
                    )}
                  >
                    SAML 2.0
                  </button>
                  <button
                    type="button"
                    onClick={() => setSsoTypeTab("oidc")}
                    className={cn(
                      "flex-1 py-1.5 px-3 rounded-md font-medium text-xs sm:text-sm transition-all text-center",
                      ssoTypeTab === "oidc"
                        ? "bg-white dark:bg-white/10 text-text-main shadow-sm"
                        : "text-text-muted hover:text-text-main"
                    )}
                  >
                    OIDC
                  </button>
                </div>
              </div>

              {/* Auth Mode selection */}
              <div className="flex flex-col gap-2">
                <label className="font-medium text-sm sm:text-base">Auth Mode</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {[
                    {
                      value: "password",
                      title: "Password only",
                      desc: "Keep legacy password login.",
                    },
                    {
                      value: "sso",
                      title: `${ssoTypeTab === "saml" ? "SAML" : "OIDC"} only`,
                      desc: "Require SSO for dashboard access.",
                    },
                    {
                      value: "both",
                      title: "Both",
                      desc: "Allow password or SSO login.",
                    },
                  ].map((option) => {
                    const currentMode = oidcForm.authMode;
                    const active =
                      option.value === "password"
                        ? currentMode === "password"
                        : option.value === "sso"
                          ? currentMode === "sso" || currentMode === "saml" || currentMode === "oidc"
                          : currentMode === "both";
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => updateOidcForm("authMode", option.value)}
                        className={cn(
                          "text-left rounded-lg border p-3 transition-colors",
                          active
                            ? "border-primary bg-primary/5"
                            : "border-border bg-bg hover:bg-black/5 dark:hover:bg-white/5"
                        )}
                        disabled={loading || oidcLoading || samlLoading}
                      >
                        <p className="font-medium text-sm sm:text-base">{option.title}</p>
                        <p className="text-xs sm:text-sm text-text-muted mt-1">{option.desc}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {ssoTypeTab === "saml" ? (
                /* SAML Configuration Panel */
                <div className="flex flex-col gap-4 pt-2 border-t border-border/50">
                  {/* IdP Setup Guidelines Banner & Collapsible Drawer */}
                  <div className="rounded-lg border border-border bg-bg/80 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setShowSamlGuide((prev) => !prev)}
                      className="w-full p-3 flex items-center justify-between gap-2 text-left hover:bg-surface/50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-primary text-lg">menu_book</span>
                        <div>
                          <p className="font-semibold text-xs sm:text-sm text-text-main">
                            IdP Setup Guidelines & Provider Configuration Instructions
                          </p>
                          <p className="text-[11px] text-text-muted">
                            Click to view setup steps for AWS IAM Identity Center, Okta, Entra ID, Keycloak, & Authentik
                          </p>
                        </div>
                      </div>
                      <span
                        className="material-symbols-outlined text-text-muted transition-transform text-lg"
                        style={{ transform: showSamlGuide ? "rotate(180deg)" : "none" }}
                      >
                        expand_more
                      </span>
                    </button>

                    {showSamlGuide && (
                      <div className="p-4 border-t border-border bg-surface/30 text-xs text-text-main flex flex-col gap-3">
                        <div className="p-2.5 rounded border border-primary/20 bg-primary/5 text-primary text-xs">
                          <p className="font-semibold mb-1">🔑 Required Service Provider (SP) Values for your IdP Setup:</p>
                          <ul className="list-disc pl-4 space-y-1 font-mono text-[11px]">
                            <li>
                              <b>Assertion Consumer Service (ACS) URL:</b>{" "}
                              <code className="bg-bg px-1 py-0.5 rounded break-all">{samlAcsUrl}</code>
                            </li>
                            <li>
                              <b>SP Entity ID / Audience URI:</b>{" "}
                              <code className="bg-bg px-1 py-0.5 rounded break-all">{samlForm.samlIssuer || "urn:9router:sp"}</code>
                            </li>
                            <li>
                              <b>NameID Format:</b>{" "}
                              <code className="bg-bg px-1 py-0.5 rounded">EmailAddress</code> or <code className="bg-bg px-1 py-0.5 rounded">Unspecified</code>
                            </li>
                          </ul>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                          <div className="p-3 rounded border border-border bg-bg/50 flex flex-col gap-1.5">
                            <p className="font-semibold text-text-main flex items-center gap-1.5">
                              <span>☁️</span> AWS IAM Identity Center
                            </p>
                            <ol className="list-decimal pl-4 text-text-muted space-y-1">
                              <li>Applications → <b>Add application</b> → Select <b>Add custom SAML 2.0 application</b>.</li>
                              <li>Set <b>Application ACS URL</b> to <code className="text-text-main font-mono">{samlAcsUrl}</code>.</li>
                              <li>Set <b>Application SAML audience</b> to <code className="text-text-main font-mono">{samlForm.samlIssuer || "urn:9router:sp"}</code>.</li>
                              <li>Under <i>Attribute mappings</i>, map <code className="text-text-main font-mono">Subject</code> or <code className="text-text-main font-mono">email</code> to <code className="text-text-main font-mono">${`{user:email}`}</code>.</li>
                              <li>Download <b>IAM Identity Center SAML metadata XML</b> file and use 1-Click Import below!</li>
                            </ol>
                          </div>

                          <div className="p-3 rounded border border-border bg-bg/50 flex flex-col gap-1.5">
                            <p className="font-semibold text-text-main flex items-center gap-1.5">
                              <span>🔷</span> Microsoft Entra ID (Azure AD)
                            </p>
                            <ol className="list-decimal pl-4 text-text-muted space-y-1">
                              <li>Enterprise Applications → <b>New application</b> → <b>Create your own application</b>.</li>
                              <li>Select <b>Single sign-on</b> → <b>SAML</b>.</li>
                              <li><b>Identifier (Entity ID):</b> <code className="text-text-main font-mono">{samlForm.samlIssuer || "urn:9router:sp"}</code></li>
                              <li><b>Reply URL (ACS):</b> <code className="text-text-main font-mono">{samlAcsUrl}</code></li>
                              <li>Download <b>Federation Metadata XML</b> and import or copy X.509 Certificate.</li>
                            </ol>
                          </div>

                          <div className="p-3 rounded border border-border bg-bg/50 flex flex-col gap-1.5">
                            <p className="font-semibold text-text-main flex items-center gap-1.5">
                              <span>🟢</span> Okta / Auth0
                            </p>
                            <ol className="list-decimal pl-4 text-text-muted space-y-1">
                              <li>Applications → <b>Create App Integration</b> → Select <b>SAML 2.0</b>.</li>
                              <li><b>Single Sign-On URL:</b> <code className="text-text-main font-mono">{samlAcsUrl}</code></li>
                              <li><b>Audience URI (SP Entity ID):</b> <code className="text-text-main font-mono">{samlForm.samlIssuer || "urn:9router:sp"}</code></li>
                              <li>Name ID format: <i>EmailAddress</i>.</li>
                              <li>Download Identity Provider metadata XML or copy the X.509 cert.</li>
                            </ol>
                          </div>

                          <div className="p-3 rounded border border-border bg-bg/50 flex flex-col gap-1.5">
                            <p className="font-semibold text-text-main flex items-center gap-1.5">
                              <span>🛡️</span> Keycloak / Authentik
                            </p>
                            <ol className="list-decimal pl-4 text-text-muted space-y-1">
                              <li>Clients → <b>Create client</b> → Select <b>SAML</b>.</li>
                              <li><b>Client ID:</b> <code className="text-text-main font-mono">{samlForm.samlIssuer || "urn:9router:sp"}</code></li>
                              <li><b>Master SAML Processing URL:</b> <code className="text-text-main font-mono">{samlAcsUrl}</code></li>
                              <li>Export SAML Descriptor XML or copy IDP Certificate PEM.</li>
                            </ol>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Quick Import Card */}
                  <div className="p-3 rounded-lg border border-dashed border-primary/40 bg-primary/5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-sm text-text-main">1-Click IdP Metadata XML Import</p>
                      <p className="text-xs text-text-muted">Auto-fill SSO URL, Issuer & Cert from XML metadata</p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      icon="upload_file"
                      onClick={() => idpMetadataFileRef.current?.click()}
                    >
                      Upload Metadata XML
                    </Button>
                    <input
                      ref={idpMetadataFileRef}
                      type="file"
                      accept=".xml,application/xml,text/xml"
                      className="hidden"
                      onChange={handleIdpMetadataUpload}
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-4">
                    <div className="flex flex-col gap-2">
                      <label className="font-medium text-sm sm:text-base">Single Sign-On Service URL (samlEntryPoint)</label>
                      <Input
                        placeholder="https://idp.example.com/app/saml/sso/..."
                        value={samlForm.samlEntryPoint}
                        onChange={(e) => updateSamlForm("samlEntryPoint", e.target.value)}
                        disabled={loading || samlLoading}
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="font-medium text-sm sm:text-base">SP Entity ID / Audience (samlIssuer)</label>
                      <Input
                        placeholder="urn:9router:sp"
                        value={samlForm.samlIssuer}
                        onChange={(e) => updateSamlForm("samlIssuer", e.target.value)}
                        disabled={loading || samlLoading}
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <label className="font-medium text-sm sm:text-base">IdP X.509 Certificate (samlCert)</label>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          icon="file_upload"
                          onClick={() => certFileRef.current?.click()}
                        >
                          Upload Certificate
                        </Button>
                        <input
                          ref={certFileRef}
                          type="file"
                          accept=".crt,.pem,.cer,text/plain"
                          className="hidden"
                          onChange={handleCertFileUpload}
                        />
                      </div>
                      <textarea
                        rows={4}
                        placeholder="-----BEGIN CERTIFICATE-----&#10;MIIC...&#10;-----END CERTIFICATE-----"
                        value={samlForm.samlCert}
                        onChange={(e) => updateSamlForm("samlCert", e.target.value)}
                        className="w-full p-2.5 rounded-lg border border-border bg-bg text-xs font-mono text-text-main focus:outline-none focus:border-primary"
                        disabled={loading || samlLoading}
                      />
                      <p className="text-xs text-text-muted">Paste raw Base64 certificate or PEM block.</p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div className="flex flex-col gap-2">
                        <label className="font-medium text-sm sm:text-base">Login Button Label</label>
                        <Input
                          placeholder="Sign in with SAML SSO"
                          value={samlForm.samlLoginLabel}
                          onChange={(e) => updateSamlForm("samlLoginLabel", e.target.value)}
                          disabled={loading || samlLoading}
                        />
                      </div>

                      <div className="flex flex-col gap-2">
                        <label className="font-medium text-sm sm:text-base">Email Claim Attribute</label>
                        <Input
                          placeholder="email"
                          value={samlForm.samlAttributeEmail}
                          onChange={(e) => updateSamlForm("samlAttributeEmail", e.target.value)}
                          disabled={loading || samlLoading}
                        />
                      </div>

                      <div className="flex flex-col gap-2">
                        <label className="font-medium text-sm sm:text-base">Display Name Claim</label>
                        <Input
                          placeholder="name"
                          value={samlForm.samlAttributeName}
                          onChange={(e) => updateSamlForm("samlAttributeName", e.target.value)}
                          disabled={loading || samlLoading}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 p-3 rounded-lg border border-border bg-bg text-xs sm:text-sm text-text-muted">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="font-medium text-text-main">ACS Callback URL</p>
                        <code className="block break-all font-mono text-xs">{samlAcsUrl}</code>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        icon="content_copy"
                        onClick={() => {
                          navigator.clipboard.writeText(samlAcsUrl);
                          setSamlStatus({ type: "success", message: "ACS URL copied to clipboard!" });
                        }}
                      >
                        Copy
                      </Button>
                    </div>
                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-border/50">
                      <div>
                        <p className="font-medium text-text-main">SP XML Metadata</p>
                        <code className="block break-all font-mono text-xs">{samlMetadataUrl}</code>
                      </div>
                      <a
                        href={samlMetadataUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        download="irouter-sp-metadata.xml"
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        <span className="material-symbols-outlined text-[16px]">download</span>
                        Download XML
                      </a>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-border/50">
                    <Button
                      type="button"
                      variant="primary"
                      loading={samlLoading}
                      onClick={() => saveSamlSettings(oidcForm.authMode)}
                      className="w-full sm:w-auto"
                    >
                      Save SAML settings
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      loading={samlTestLoading}
                      onClick={testSamlConnection}
                      className="w-full sm:w-auto"
                    >
                      Test SAML settings
                    </Button>
                  </div>

                  {samlTestStatus.message && (
                    <p className={`text-xs sm:text-sm ${samlTestStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                      {samlTestStatus.message}
                    </p>
                  )}

                  {samlStatus.message && (
                    <p className={`text-xs sm:text-sm ${samlStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                      {samlStatus.message}
                    </p>
                  )}
                </div>
              ) : (
                /* OIDC Panel */
                <div className="flex flex-col gap-4 pt-2 border-t border-border/50">
                  <div className="grid grid-cols-1 gap-4">
                    <div className="flex flex-col gap-2">
                      <label className="font-medium text-sm sm:text-base">Issuer URL</label>
                      <Input
                        placeholder="https://auth.example.com/application/o/9router/"
                        value={oidcForm.oidcIssuerUrl}
                        onChange={(e) => updateOidcForm("oidcIssuerUrl", e.target.value)}
                        disabled={loading || oidcLoading}
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="font-medium text-sm sm:text-base">Client ID</label>
                      <Input
                        placeholder="irouter-dashboard"
                        value={oidcForm.oidcClientId}
                        onChange={(e) => updateOidcForm("oidcClientId", e.target.value)}
                        disabled={loading || oidcLoading}
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="font-medium text-sm sm:text-base">Client Secret</label>
                      <Input
                        type="password"
                        placeholder="Leave blank to keep existing secret"
                        value={oidcClientSecret}
                        onChange={(e) => setOidcClientSecret(e.target.value)}
                        disabled={loading || oidcLoading}
                      />
                      <p className="text-xs sm:text-sm text-text-muted">This value is write-only after saving.</p>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="font-medium text-sm sm:text-base">Scopes</label>
                      <Input
                        placeholder="openid profile email"
                        value={oidcForm.oidcScopes}
                        onChange={(e) => updateOidcForm("oidcScopes", e.target.value)}
                        disabled={loading || oidcLoading}
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="font-medium text-sm sm:text-base">Login Button Label</label>
                      <Input
                        placeholder="Sign in with OIDC"
                        value={oidcForm.oidcLoginLabel}
                        onChange={(e) => updateOidcForm("oidcLoginLabel", e.target.value)}
                        disabled={loading || oidcLoading}
                      />
                    </div>
                  </div>

                  <div className="rounded-lg border border-border bg-bg p-3 text-xs sm:text-sm text-text-muted">
                    <p className="font-medium text-text-main mb-1">Redirect URI</p>
                    <code className="block break-all font-mono">{oidcRedirectUri}</code>
                  </div>

                  <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-border/50">
                    <Button type="button" variant="primary" loading={oidcLoading} onClick={() => saveOidcSettings()} className="w-full sm:w-auto">
                      Save OIDC settings
                    </Button>
                    <Button type="button" variant="outline" loading={oidcTestLoading} onClick={testOidcConnection} className="w-full sm:w-auto">
                      Test connection
                    </Button>
                  </div>

                  {oidcTestStatus.message && (
                    <p className={`text-xs sm:text-sm ${oidcTestStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                      {oidcTestStatus.message}
                    </p>
                  )}

                  {oidcStatus.message && (
                    <p className={`text-xs sm:text-sm ${oidcStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                      {oidcStatus.message}
                    </p>
                  )}
                </div>
              )}

              {settings.authMode === "oidc" || settings.authMode === "saml" || settings.authMode === "sso" ? (
                <p className="text-xs sm:text-sm text-amber-600 dark:text-amber-400">
                  SSO login ({settings.ssoType === "saml" ? "SAML 2.0" : "OIDC"}) is currently active. Password login is disabled until you switch back.
                </p>
              ) : null}

              {settings.authMode === "both" && (
                <p className="text-xs sm:text-sm text-amber-600 dark:text-amber-400">
                  Password and SSO login ({settings.ssoType === "saml" ? "SAML 2.0" : "OIDC"}) are both active.
                </p>
              )}
            </div>
          )}
        </Card>

        {/* Routing Preferences */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-blue-500/10 text-blue-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">route</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">Routing Strategy</h3>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Round Robin</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  Cycle through accounts to distribute load
                </p>
              </div>
              <Toggle
                checked={settings.fallbackStrategy === "round-robin"}
                onChange={() => updateFallbackStrategy(settings.fallbackStrategy === "round-robin" ? "fill-first" : "round-robin")}
                disabled={loading}
              />
            </div>

            {/* Sticky Round Robin Limit */}
            {settings.fallbackStrategy === "round-robin" && (
              <div className="flex items-start sm:items-center justify-between gap-4 pt-2 border-t border-border/50">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm sm:text-base">Sticky Limit</p>
                  <p className="text-xs sm:text-sm text-text-muted">
                    Calls per account before switching
                  </p>
                </div>
                <Input
                  type="number"
                  min="1"
                  max="10"
                  value={settings.stickyRoundRobinLimit || 3}
                  onChange={(e) => updateStickyLimit(e.target.value)}
                  disabled={loading}
                  className="w-16 sm:w-20 text-center shrink-0"
                />
              </div>
            )}

            {/* Combo Round Robin */}
            <div className="flex items-start sm:items-center justify-between gap-4 pt-4 border-t border-border/50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Combo Round Robin</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  Cycle through providers in combos instead of always starting with first
                </p>
              </div>
              <Toggle
                checked={settings.comboStrategy === "round-robin"}
                onChange={() => updateComboStrategy(settings.comboStrategy === "round-robin" ? "fallback" : "round-robin")}
                disabled={loading}
              />
            </div>

            {/* Effort-aware routing（自维护特性，ADR 0003） */}
            <div className="flex items-start sm:items-center justify-between gap-4 pt-4 border-t border-border/50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Effort-aware Routing</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  Prefer combo members whose declared effort cap supports the requested reasoning effort
                </p>
              </div>
              <Toggle
                checked={settings.effortAwareRoute !== false}
                onChange={() => updateEffortAwareRoute(settings.effortAwareRoute === false)}
                disabled={loading}
              />
            </div>

            {/* Combo Sticky Round Robin Limit */}
            {settings.comboStrategy === "round-robin" && (
              <div className="flex items-center justify-between pt-2 border-t border-border/50">
                <div>
                  <p className="font-medium">Combo Sticky Limit</p>
                  <p className="text-sm text-text-muted">
                    Calls per combo model before switching
                  </p>
                </div>
                <Input
                  type="number"
                  min="1"
                  max="100"
                  value={settings.comboStickyRoundRobinLimit || 1}
                  onChange={(e) => updateComboStickyLimit(e.target.value)}
                  disabled={loading}
                  className="w-20 text-center"
                />
              </div>
            )}

            {/* i18n translates by exact match on a text node, so each fragment
                needs its own node: without the wrapping <span>s React coalesces
                "calls per account." and "Combos rotate after" into a single node
                and neither sentence matches a dictionary key (this block used to
                stay English in every locale). The count is its own element, same
                shape as Pagination, keeping the surrounding text static. */}
            <p className="text-xs text-text-muted italic pt-2 border-t border-border/50">
              {settings.fallbackStrategy === "round-robin" ? (
                <span>
                  Currently distributing requests across all available accounts with{" "}
                  <span>{settings.stickyRoundRobinLimit || 3}</span> calls per account.
                </span>
              ) : (
                <span>Currently using accounts in priority order (Fill First).</span>
              )}{" "}
              {settings.comboStrategy === "round-robin" ? (
                <span>
                  Combos rotate after{" "}
                  <span>{settings.comboStickyRoundRobinLimit || 1}</span>{" "}
                  {(settings.comboStickyRoundRobinLimit || 1) === 1 ? "call" : "calls"} per model.
                </span>
              ) : (
                <span>Combos always start with their first model.</span>
              )}
            </p>
          </div>
        </Card>

        {/* Retry Strategy（自维护特性，ADR 0003） */}
        <RetryStrategyCard settings={settings} onChange={updateAutoRetry} loading={loading} />

        {/* Redaction Policy（ADR 0005）：转发前检测并改写敏感内容。
            仅覆盖出站字节——本机 requestDetails 落盘仍是明文。 */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-rose-500/10 text-rose-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">policy</span>
            </div>
            <div className="min-w-0">
              <h3 className="text-base sm:text-lg font-semibold">Redaction Policy</h3>
              <p className="text-xs sm:text-sm text-text-muted">
                Detect secrets (API keys, private keys, ID/bank cards) in the request body before
                forwarding upstream. Outbound only — request details stored locally are still kept
                in plain text.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-4">

            {/* option 文案带逐档说明：runtime i18n 的 skipTags 比对的是**直接父元素**，
                <option> 不在其中，故 option 文本同样被翻译（整句作 key，无通用词碰撞）。
                实测依据见 tests/unit/i18n-runtime.test.js。 */}
            <Select
              label="Mode"
              value={dlpMode}
              disabled={loading}
              onChange={(e) => updateDlpSetting({ dlpMode: e.target.value })}
              options={[
                { value: "off", label: "Off — forward everything unchanged" },
                { value: "audit", label: "Audit — log matches, forward unchanged" },
                { value: "redact", label: "Redact — replace matches with [REDACTED:rule]" },
                { value: "block", label: "Block — reject the request with HTTP 422" },
              ]}
            />

            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Match stored credentials</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  Exact-match against the API keys and tokens already stored in this app. Zero false
                  positives. Only the rule name is logged, never the value.
                </p>
              </div>
              <Toggle
                checked={dlpKnownSecrets}
                onChange={() => updateDlpSetting({ dlpKnownSecrets: !dlpKnownSecrets })}
                disabled={loading || dlpMode === "off"}
              />
            </div>

            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Allow exemption markers</p>
                {/* 标记字面量必须留在 <code> 内：code 在 runtime i18n 的 skipTags 内不参与翻译，
                    也不会把描述句切成多个文本节点（那会导致整句匹配不上字典）。
                    此前为过 i18n 检查删掉过它们，结果只剩一个开关、用户无从得知写什么——勿再删。 */}
                <p className="text-xs sm:text-sm text-text-muted">
                  Everything between the two markers skips inspection and reaches the provider
                  unchanged. Use it to send something a rule keeps flagging by mistake.
                </p>

                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <code className="px-1.5 py-0.5 rounded bg-surface-2 font-mono text-[11px]">[[ALLOW_SENSITIVE]]</code>
                  <span className="text-[11px] text-text-muted">your text</span>
                  <code className="px-1.5 py-0.5 rounded bg-surface-2 font-mono text-[11px]">[[/ALLOW_SENSITIVE]]</code>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => copy("[[ALLOW_SENSITIVE]] your text [[/ALLOW_SENSITIVE]]", "dlp-markers")}
                  >
                    {copied === "dlp-markers" ? "Copied" : "Copy"}
                  </Button>
                </div>

                {/* 具体效果：同一个串，包与不包的区别。用示例而非术语说明，GUI 用户一眼可懂。
                    示例串取「形状上确实会被 ai_tokens 命中」的值，避免演示与实际行为不符。 */}
                <div className="mt-2 rounded-lg border border-border/60 bg-surface-2/40 px-2.5 py-2 space-y-1">
                  <div className="flex items-start gap-2 text-[11px]">
                    <span className="text-emerald-500 font-bold shrink-0">✓</span>
                    <code className="font-mono break-all">[[ALLOW_SENSITIVE]]sk-live-9f3a2b7c1d8e4f6a[[/ALLOW_SENSITIVE]]</code>
                  </div>
                  <div className="flex items-start gap-2 text-[11px] pl-4">
                    <span className="text-text-muted shrink-0">→</span>
                    <span className="text-text-muted">sent unchanged, markers removed</span>
                  </div>
                  <div className="flex items-start gap-2 text-[11px] pt-1">
                    <span className="text-red-500 font-bold shrink-0">✗</span>
                    <code className="font-mono break-all">sk-live-9f3a2b7c1d8e4f6a</code>
                  </div>
                  <div className="flex items-start gap-2 text-[11px] pl-4">
                    <span className="text-text-muted shrink-0">→</span>
                    <code className="font-mono text-text-muted">[REDACTED:ai_tokens]</code>
                  </div>
                </div>
              </div>
              <Toggle
                checked={dlpAllowExemptions}
                onChange={() => updateDlpSetting({ dlpAllowExemptions: !dlpAllowExemptions })}
                disabled={loading || dlpMode === "off"}
              />
            </div>
          </div>
        </Card>


        {/* Network */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-purple-500/10 text-purple-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">wifi</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">Network</h3>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Outbound Proxy</p>
                <p className="text-xs sm:text-sm text-text-muted">Enable proxy for OAuth + provider outbound requests.</p>
              </div>
              <Toggle
                checked={settings.outboundProxyEnabled === true}
                onChange={() => updateOutboundProxyEnabled(!(settings.outboundProxyEnabled === true))}
                disabled={loading || proxyLoading}
              />
            </div>

            {settings.outboundProxyEnabled === true && (
              <form onSubmit={updateOutboundProxy} className="flex flex-col gap-4 pt-2 border-t border-border/50">
                <div className="flex flex-col gap-2">
                  <label className="font-medium text-sm sm:text-base">Proxy URL</label>
                  <Input
                    placeholder="http://127.0.0.1:7897"
                    value={proxyForm.outboundProxyUrl}
                    onChange={(e) => setProxyForm((prev) => ({ ...prev, outboundProxyUrl: e.target.value }))}
                    disabled={loading || proxyLoading}
                  />
                  <p className="text-xs sm:text-sm text-text-muted">Leave empty to inherit existing env proxy (if any).</p>
                </div>

                <div className="flex flex-col gap-2 pt-2 border-t border-border/50">
                  <label className="font-medium text-sm sm:text-base">No Proxy</label>
                  <Input
                    placeholder="localhost,127.0.0.1"
                    value={proxyForm.outboundNoProxy}
                    onChange={(e) => setProxyForm((prev) => ({ ...prev, outboundNoProxy: e.target.value }))}
                    disabled={loading || proxyLoading}
                  />
                  <p className="text-xs sm:text-sm text-text-muted">Comma-separated hostnames/domains to bypass the proxy.</p>
                </div>

                <div className="pt-2 border-t border-border/50 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    loading={proxyTestLoading}
                    disabled={loading || proxyLoading}
                    onClick={testOutboundProxy}
                    className="w-full sm:w-auto"
                  >
                    Test proxy URL
                  </Button>
                  <Button type="submit" variant="primary" loading={proxyLoading} className="w-full sm:w-auto">
                    Apply
                  </Button>
                </div>
              </form>
            )}

            {proxyStatus.message && (
              <p className={`text-xs sm:text-sm ${proxyStatus.type === "error" ? "text-red-500" : "text-green-500"} pt-2 border-t border-border/50`}>
                {proxyStatus.message}
              </p>
            )}
          </div>
        </Card>

        {/* Observability Settings */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-orange-500/10 text-orange-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">monitoring</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">Observability</h3>
          </div>
          <div className="flex items-start sm:items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm sm:text-base">Enable Observability</p>
              <p className="text-xs sm:text-sm text-text-muted">
                Record request details for inspection in the logs view
              </p>
            </div>
            <Toggle
              checked={observabilityEnabled}
              onChange={updateObservabilityEnabled}
              disabled={loading}
            />
          </div>
          <div className="flex items-start sm:items-center justify-between gap-4 pt-4 mt-4 border-t border-border">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm sm:text-base">Print Full Error Logs</p>
              <p className="text-xs sm:text-sm text-text-muted">
                Include the full request sent to the model and the full upstream response body in the console log (off by default)
              </p>
            </div>
            <Toggle
              checked={verboseErrorLog}
              onChange={updateVerboseErrorLog}
              disabled={loading}
            />
          </div>
        </Card>

        {/* Pricing rates (used by the usage cost estimates) */}
        <Card>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500 shrink-0">
                <span className="material-symbols-outlined text-[20px]">payments</span>
              </div>
              <div className="min-w-0">
                <h3 className="text-base sm:text-lg font-semibold">Pricing</h3>
                <p className="text-xs sm:text-sm text-text-muted">
                  Token rates behind the estimated cost in usage statistics
                </p>
              </div>
            </div>
            <Button variant="outline" onClick={() => setPricingOpen(true)}>
              Edit Pricing
            </Button>
          </div>
        </Card>

        {/* App Info */}
        <div className="text-center text-xs sm:text-sm text-text-muted py-4">
          <p>{APP_CONFIG.name} v{APP_CONFIG.version}</p>
          <p className="mt-1">{isRemoteHost ? "Remote Mode" : "Local Mode - All data stored on your machine"}</p>
        </div>
      </div>

      <PricingModal isOpen={pricingOpen} onClose={() => setPricingOpen(false)} />
    </div>
  );
}

// 自动重试（自维护特性，ADR 0003）：完整语义见 open-sse/services/autoRetry.js。
const AUTO_RETRY_DEFAULTS = {
  enabled: true,
  statusCodes: [429, 500, 502, 503, 504, 529],
  maxRetries: 20,
  memberRetries: 0,
  accountRetries: 0,
  intervalSeconds: 5,
  backoff: true,
  backoffMaxSeconds: 60,
  retryAfterMaxSeconds: 120,
  totalWaitBudgetSeconds: 600,
  rateLimitLockMaxSeconds: 120,
  rateLimitLockBaseSeconds: 2,
  comboStickyRespectRetries: false,
};

function RetryStrategyCard({ settings, onChange, loading }) {
  const ar = { ...AUTO_RETRY_DEFAULTS, ...(settings.autoRetry || {}) };
  const num = (label, desc, key, { min = 0, max = 99999 } = {}) => (
    <div className="flex items-center justify-between gap-4 pt-2 border-t border-border/50">
      <div className="min-w-0">
        <p className="font-medium text-sm sm:text-base">{label}</p>
        <p className="text-xs sm:text-sm text-text-muted">{desc}</p>
      </div>
      <Input
        type="number"
        min={min}
        max={max}
        value={ar[key]}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          if (Number.isInteger(v) && v >= min && v <= max) onChange({ [key]: v });
        }}
        disabled={loading}
        className="w-20 text-center"
      />
    </div>
  );

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500 shrink-0">
          <span className="material-symbols-outlined text-[20px]">autorenew</span>
        </div>
        <h3 className="text-base sm:text-lg font-semibold">Retry Strategy</h3>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-start sm:items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm sm:text-base">Auto Retry</p>
            <p className="text-xs sm:text-sm text-text-muted">
              Hold failing requests (429/5xx) and retry automatically so agents keep running
            </p>
          </div>
          <Toggle
            checked={ar.enabled !== false}
            onChange={(v) => onChange({ enabled: v })}
            disabled={loading}
          />
        </div>

        {ar.enabled !== false && (
          <>
            {num("Max Retries", "Whole-request retries after all combo members fail (0 = unlimited)", "maxRetries", { max: 999 })}
            {num("Member Retries", "Retry the same combo member on 429/5xx before switching (0 = off)", "memberRetries", { max: 50 })}
            {num("Account Retries", "Retry the same account on 429 before switching (0 = off)", "accountRetries", { max: 100 })}
            <div className="flex items-center justify-between gap-4 pt-2 border-t border-border/50">
              <div className="min-w-0">
                <p className="font-medium text-sm sm:text-base">Respect Retries in Sticky</p>
                <p className="text-xs sm:text-sm text-text-muted">Wait for retries to finish before advancing sticky counter; advance only on success (off = advance immediately)</p>
              </div>
              <Toggle
                checked={ar.comboStickyRespectRetries === true}
                onChange={(v) => onChange({ comboStickyRespectRetries: v })}
                disabled={loading}
              />
            </div>
            {num("Interval (s)", "Base wait between retries", "intervalSeconds", { min: 1, max: 600 })}
            <div className="flex items-center justify-between gap-4 pt-2 border-t border-border/50">
              <div className="min-w-0">
                <p className="font-medium text-sm sm:text-base">Exponential Backoff</p>
                <p className="text-xs sm:text-sm text-text-muted">Double the wait each attempt and respect upstream Retry-After (off = fixed interval)</p>
              </div>
              <Toggle
                checked={ar.backoff !== false}
                onChange={(v) => onChange({ backoff: v })}
                disabled={loading}
              />
            </div>
            {num("Backoff Max (s)", "Exponential backoff ceiling", "backoffMaxSeconds", { max: 3600 })}
            {num("Retry-After Cap (s)", "Clamp upstream Retry-After so one provider can't hold a request too long (0 = no cap)", "retryAfterMaxSeconds", { max: 3600 })}
            {num("Rate Limit Lock Max (s)", "Maximum cooldown lock duration when 429 rate limited (0 = do not lock)", "rateLimitLockMaxSeconds", { max: 3600 })}
            {num("Rate Limit Lock Base (s)", "Base cooldown seconds for 429 rate limit errors", "rateLimitLockBaseSeconds", { min: 1, max: 600 })}
            {num("Total Wait Budget (s)", "Cumulative wait ceiling per request (0 = unlimited)", "totalWaitBudgetSeconds", { max: 36000 })}
            <div className="flex items-center justify-between gap-4 pt-2 border-t border-border/50">
              <div className="min-w-0">
                <p className="font-medium text-sm sm:text-base">Status Codes</p>
                <p className="text-xs sm:text-sm text-text-muted">Comma-separated codes that trigger retry (rate-limit text always matches)</p>
              </div>
              <Input
                value={(ar.statusCodes || []).join(", ")}
                onChange={(e) => {
                  const list = e.target.value.split(",").map(s => parseInt(s.trim(), 10)).filter(Number.isInteger);
                  if (list.length > 0) onChange({ statusCodes: list });
                }}
                disabled={loading}
                className="w-40 text-center"
              />
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
