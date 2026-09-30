"use client";

// 软件更新：检查、下载、校验与安装引导。
//
// 状态提到 useSoftwareUpdate 里，是因为面板左栏要给「软件更新」项点一个小圆点：
// 更新可用时用户得在**不滚到底**的情况下看见它。hook 由模态框调用一次，
// 结果既给导航也给这一段，避免两处各订阅一遍 IPC。
import { useEffect, useState } from "react";
import Button from "@/shared/components/Button";
import { formatBytes } from "./storageFeedback";
import { Group, Notice, Row, SectionBody, SectionHeader, Switch } from "./parts";

/**
 * 订阅壳层主进程的更新事件，并暴露手动检查/下载/安装动作
 *
 * @return {object} 更新状态与动作
 * @author wei
 * @since 2026-09-29
 */
export function useSoftwareUpdate() {
  const [state, setState] = useState("idle");
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState({ downloaded: 0, total: 0, percent: 0 });
  const [downloadInfo, setDownloadInfo] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const shellApi = typeof window !== "undefined" ? window.irouterShell : null;
    if (!shellApi) return;

    const unsubAvail = shellApi.onUpdateAvailable?.((res) => {
      setResult(res);
      if (res.updateAvailable) {
        setState("available");
      } else if (res.error) {
        setState("error");
        setErrorMsg(res.error);
      } else {
        setState("idle");
      }
    });

    const unsubProg = shellApi.onUpdateProgress?.((p) => {
      setState("downloading");
      setProgress(p);
    });

    const unsubDown = shellApi.onUpdateDownloaded?.((info) => {
      setState("downloaded");
      setDownloadInfo(info);
    });

    const unsubErr = shellApi.onUpdateError?.((err) => {
      setState("error");
      setErrorMsg(err);
    });

    // 同步一次「已知结论」：主进程的自动检查若在本组件挂载**之前**完成，那次
    // push 就错过了，面板会一直显示「空闲」——左栏的小圆点与页脚状态也就永不出现。
    // force=false 走主进程的 4 小时缓存，不会额外打网络。
    shellApi
      .checkUpdate?.(false)
      .then((res) => {
        if (!res || res.error) return; // 静默：自动检查的失败不摆到界面上
        setState((prev) =>
          prev === "idle" && res.updateAvailable ? "available" : prev,
        );
        setResult((prev) => prev ?? res);
      })
      .catch(() => {});

    return () => {
      unsubAvail?.();
      unsubProg?.();
      unsubDown?.();
      unsubErr?.();
    };
  }, []);

  const api = () => (typeof window !== "undefined" ? window.irouterShell : null);

  const checkNow = async () => {
    const shellApi = api();
    if (!shellApi || state === "checking") return;
    setState("checking");
    setErrorMsg("");
    try {
      const res = await shellApi.checkUpdate(true);
      setResult(res);
      if (res.error) {
        setState("error");
        setErrorMsg(res.error);
      } else if (res.updateAvailable) {
        setState("available");
      } else {
        setState("idle");
      }
    } catch (e) {
      setState("error");
      setErrorMsg(e.message || "Update check failed");
    }
  };

  const startDownload = async () => {
    const shellApi = api();
    if (!shellApi) return;
    setState("downloading");
    setProgress({ downloaded: 0, total: result?.assetSize || 0, percent: 0 });
    try {
      await shellApi.downloadUpdate();
    } catch (e) {
      setState("error");
      setErrorMsg(e.message || "Download failed");
    }
  };

  const cancelDownload = async () => {
    const shellApi = api();
    if (!shellApi) return;
    await shellApi.cancelDownload();
    setState("available");
  };

  const installUpdate = async () => {
    const shellApi = api();
    if (!shellApi) return;
    await shellApi.installUpdate();
  };

  const ignoreVersion = async () => {
    const shellApi = api();
    if (!shellApi || !result?.latest) return;
    await shellApi.ignoreVersion(result.latest);
    setState("idle");
  };

  const openReleaseUrl = () => {
    const url =
      result?.releaseURL || "https://github.com/kevinjoy89/iRouter/releases";
    window.open(url, "_blank");
  };

  return {
    state,
    result,
    progress,
    downloadInfo,
    errorMsg,
    updateAvailable: state === "available",
    checkNow,
    startDownload,
    cancelDownload,
    installUpdate,
    ignoreVersion,
    openReleaseUrl,
  };
}

/**
 * 软件更新段
 *
 * @param {object} props 组件属性
 * @param {object} props.shell 壳层配置对象
 * @param {Function} props.onSettingChange 配置变更回调
 * @param {object} props.update useSoftwareUpdate() 的返回值
 * @return {JSX.Element} 软件更新交互区块
 * @author wei
 * @since 2026-09-29
 */
export default function UpdateSettings({ shell, onSettingChange, update }) {
  const {
    state,
    result,
    progress,
    downloadInfo,
    errorMsg,
    checkNow,
    startDownload,
    cancelDownload,
    installUpdate,
    ignoreVersion,
    openReleaseUrl,
  } = update;

  const isUpToDate = state === "idle" && result && !result.updateAvailable;

  const statusHint =
    state === "available" && result?.latest
      ? "A new version is available"
      : isUpToDate
        ? "Current version is up to date"
        : null;

  return (
    <>
      <SectionHeader
        title="Software Update"
        description="Check for new releases and install them without leaving the app"
      />
      <SectionBody>
        <Group>
          <Row
            label="Automatically check for updates"
            hint="Check for new releases in the background"
          >
            <Switch
              name="checkUpdates"
              label="Automatically check for updates"
              checked={shell.checkUpdates !== false}
              onChange={(v) => onSettingChange("checkUpdates", v)}
            />
          </Row>

          <Row label="Check for Updates" hint={statusHint}>
            {state === "checking" ? (
              <Button variant="secondary" size="sm" loading disabled>
                Checking...
              </Button>
            ) : state === "available" ? (
              <Button variant="primary" size="sm" onClick={startDownload}>
                Download
              </Button>
            ) : state === "downloading" ? (
              <Button variant="outline" size="sm" onClick={cancelDownload}>
                Cancel
              </Button>
            ) : state === "downloaded" ? (
              <Button variant="primary" size="sm" onClick={installUpdate}>
                Install and Relaunch
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={checkNow}>
                Check now
              </Button>
            )}
          </Row>
        </Group>

        {state === "available" ? (
          <Group>
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="material-symbols-outlined text-[20px] text-brand-500">
                system_update_alt
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] leading-5 font-medium text-text-main tabular-nums">
                  {result?.latest}
                </div>
                {Number.isFinite(result?.assetSize) && result.assetSize > 0 ? (
                  <div className="text-[12px] text-text-muted">
                    {formatBytes(result.assetSize)}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-2 px-4 py-2">
              <Button variant="ghost" size="sm" onClick={ignoreVersion}>
                Ignore this version
              </Button>
              <Button variant="ghost" size="sm" onClick={openReleaseUrl}>
                Release Notes
              </Button>
            </div>
          </Group>
        ) : null}

        {state === "downloading" ? (
          <Group>
            <div className="flex items-center gap-3 px-4 py-3.5">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center justify-between text-[12px]">
                  <span className="text-text-muted">Downloading update...</span>
                  <span className="text-text-main tabular-nums">
                    {progress.percent}%
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                  <div
                    className="h-full rounded-full bg-brand-500 transition-all duration-200"
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
              </div>
            </div>
          </Group>
        ) : null}

        {state === "downloaded" ? (
          <>
            <Notice tone="success">
              Update downloaded and verified via SHA-256
            </Notice>
            {downloadInfo?.isArchive ? (
              <p className="px-1 text-[12px] text-text-muted">
                Portable archive saved to Downloads folder
              </p>
            ) : null}
          </>
        ) : null}

        {state === "error" ? (
          <>
            <Notice tone="error">
              {errorMsg || "Update check failed"}
            </Notice>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={checkNow}>
                Retry
              </Button>
              <Button variant="ghost" size="sm" onClick={openReleaseUrl}>
                View on GitHub
              </Button>
            </div>
          </>
        ) : null}

        {isUpToDate ? (
          <Notice tone="success">Current version is up to date</Notice>
        ) : null}
      </SectionBody>
    </>
  );
}
