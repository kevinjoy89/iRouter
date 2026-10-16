pub mod engine;
pub mod metrics;
pub mod protocols;
pub mod types;

pub mod commands {
    use tauri::{AppHandle, Emitter};
    use super::engine::{execute_speedtest, REGISTRY};
    use super::types::{SpeedtestConfig, SpeedtestResult};

    /**
     * 启动模型单次流式测速的 Tauri IPC 命令
     *
     * @param app Tauri 运行时应用句柄引用
     * @param config 前端传递的测速配置结构体
     * @return 终态评测结果或错误信息
     */
    #[tauri::command]
    pub async fn speedtest_run(
        app: AppHandle,
        config: SpeedtestConfig,
    ) -> Result<SpeedtestResult, String> {
        let session_id = config.session_id.clone();
        let abort_flag = REGISTRY.register(&session_id);

        let app_handle = app.clone();
        let on_progress = move |progress| {
            let _ = app_handle.emit("speedtest:progress", progress);
        };

        let result = execute_speedtest(config, abort_flag, on_progress).await;
        REGISTRY.unregister(&session_id);
        result
    }

    /**
     * 主动中止正在执行的模型测速任务
     *
     * @param session_id 待中止的测速会话标识符
     * @return 是否成功发出中止信号
     */
    #[tauri::command]
    pub async fn speedtest_abort(session_id: String) -> Result<bool, String> {
        let aborted = REGISTRY.abort(&session_id);
        Ok(aborted)
    }
}
