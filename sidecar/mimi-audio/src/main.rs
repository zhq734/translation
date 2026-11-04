//! mimi-audio-sidecar：实时字幕采集与识别的 stdio 行协议可执行文件。
//!
//! 移植自 Mimi（MIT，Copyright (c) 2026 yuxino）的 macOS 音频采集与实时识别层，
//! 已去除 Tauri 运行时依赖。原始 PCM 只在 sidecar 内部处理，对外只输出
//! `ready` / `partial` / `final` / `level` / `status` / `error` 文本事件。

mod asr;
mod audio;
mod protocol;
mod reducer;
mod session;

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};
use tracing_subscriber::EnvFilter;

use crate::protocol::Event;
use crate::session::SessionManager;

/// 事件输出通道容量；文本事件频率低，容量足够吸收突发。
const EVENT_CHANNEL_CAPACITY: usize = 256;

/// sidecar 进程入口：解析控制命令并转发 stdout 事件。
///
/// # 返回值
/// 进程退出码；正常 EOF 退出返回 0。
#[tokio::main]
async fn main() -> std::process::ExitCode {
    // tokio-tungstenite 的 rustls 依赖未固定默认加密后端；进程启动时显式安装
    // ring provider，避免首次 WebSocket 握手在后台线程 panic 并导致界面永久停留在启动中。
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_err()
    {
        tracing::warn!("rustls crypto provider was already installed");
    }

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn")))
        .with_writer(std::io::stderr)
        .init();

    let (event_tx, mut event_rx) = mpsc::channel::<Event>(EVENT_CHANNEL_CAPACITY);
    let manager = Arc::new(Mutex::new(SessionManager::new(event_tx.clone())));

    // 事件泵：把 sidecar 事件逐行写到 stdout，保证 JSON lines 原子性。
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(event) = event_rx.recv().await {
            let line = event.to_line();
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdout.flush().await.is_err() {
                break;
            }
        }
    });

    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<protocol::Command>(trimmed) {
            Ok(command) => {
                let mut guard = manager.lock().await;
                guard.handle_command(command).await;
            }
            Err(error) => {
                tracing::warn!(%error, "invalid control command");
                let _ = event_tx
                    .send(Event::Error {
                        code: protocol::ErrorCode::Unknown,
                        message: Some("invalid control command".into()),
                    })
                    .await;
            }
        }
    }

    {
        let mut guard = manager.lock().await;
        guard.shutdown().await;
    }
    // 释放 manager 持有的 event_tx 克隆，否则事件泵永远等不到通道关闭，
    // 进程会在 stdin EOF 后挂起不退出。
    drop(manager);
    drop(event_tx);
    let _ = writer.await;
    std::process::ExitCode::SUCCESS
}
