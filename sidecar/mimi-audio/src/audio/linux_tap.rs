//! Linux 系统声音采集：PulseAudio/PipeWire 默认 sink monitor 源。
//!
//! 本文件为本项目原创实现（MIT，作者 zhenghq），未照抄任何上游版权代码。
//! 通过 libpulse-binding 连接本地 PulseAudio（或 PipeWire 的 pipewire-pulse
//! 兼容层）服务器，查询默认 sink 并拼接 `<sink>.monitor` 作为采集源，再用
//! libpulse-simple-binding 打开 S16LE 立体声录制流。服务器会自动完成格式
//! 转换，工作线程读取固定块后降混、重采样为 24 kHz 单声道 i16，与 macOS
//! 实现保持一致的数据契约。
//!
//! 仅支持存在 PulseAudio 兼容层的环境；纯 ALSA/JACK（无 pipewire-pulse 或
//! pulseaudio）不在覆盖范围内。

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use libpulse_binding as pulse;
use libpulse_simple_binding as psimple;
use pulse::callbacks::ListResult;
use pulse::context::{Context, FlagSet, State as ContextState};
use pulse::mainloop::standard::{IterateResult, Mainloop};
use pulse::operation::{Operation, State as OperationState};
use pulse::proplist::{properties, Proplist};
use pulse::sample::{Format, Spec};
use pulse::stream::Direction;

use super::pcm::decode_i16;
use super::streaming_resampler::StreamingPcm16Resampler;
use super::CaptureError;

/// 目标采样率：Deepgram 实时识别使用 24 kHz PCM16。
const TARGET_SAMPLE_RATE_HZ: u32 = 24_000;
/// 默认采集采样率：monitor 源原生速率异常时回退使用。
const DEFAULT_CAPTURE_RATE_HZ: u32 = 48_000;
/// 采集声道数：固定请求立体声，PA/PipeWire 会把 monitor 混音成立体声。
const CAPTURE_CHANNELS: u8 = 2;
/// 允许的原生采集速率下限，超出范围视为异常数据。
const MIN_NATIVE_RATE_HZ: u32 = 8_000;
/// 允许的原生采集速率上限，超出范围视为异常数据。
const MAX_NATIVE_RATE_HZ: u32 = 192_000;
/// 单次读取的音频块时长。
const READ_BLOCK: Duration = Duration::from_millis(20);
/// 等待上下文就绪与查询操作完成的超时时间。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// 主循环非阻塞分发后的轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(5);

/// 默认 sink monitor 探测结果。
struct MonitorProbe {
    /// 采集源名称，形如 `<sink>.monitor`。
    source_name: String,
    /// monitor 源的原生采样率。
    sample_rate_hz: u32,
}

/// 启动 Linux 系统声音（默认 sink monitor）采集线程。
///
/// # 参数
/// - `sink`：PCM16 单声道采样输出通道。
/// - `paused`：暂停标志，为真时丢弃音频。
/// - `running`：运行标志，为假时线程退出并释放录制流。
/// - `errors`：运行期间设备故障的错误发送端。
///
/// # 返回值
/// 启动成功返回采集线程句柄，否则返回分类错误。
///
/// @author zhenghq
pub fn start(
    sink: tokio::sync::mpsc::Sender<Vec<i16>>,
    paused: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    errors: tokio::sync::mpsc::UnboundedSender<CaptureError>,
) -> Result<std::thread::JoinHandle<()>, CaptureError> {
    let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), CaptureError>>(1);
    let handle = std::thread::Builder::new()
        .name("mimi-linux-system-audio".into())
        .spawn(move || match open_capture_stream() {
            Ok((simple, sample_rate_hz)) => {
                let mut resampler = match StreamingPcm16Resampler::new(
                    sample_rate_hz,
                    TARGET_SAMPLE_RATE_HZ,
                    CAPTURE_CHANNELS as usize,
                ) {
                    Ok(resampler) => resampler,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                if ready_tx.send(Ok(())).is_err() {
                    return;
                }
                run_read_loop(
                    simple,
                    sink,
                    paused,
                    running,
                    errors,
                    &mut resampler,
                    sample_rate_hz,
                );
            }
            Err(error) => {
                let _ = ready_tx.send(Err(error));
            }
        })
        .map_err(|_| CaptureError::DeviceUnavailable)?;
    ready_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| CaptureError::DeviceUnavailable)??;
    Ok(handle)
}

/// 判断当前环境是否可进行系统声音采集。
///
/// 需要能连接本地 PulseAudio/PipeWire 服务器，且默认 sink 的 monitor 源存在。
///
/// # 返回值
/// 满足条件返回 `true`，否则返回 `false`。
///
/// @author zhenghq
pub fn is_available() -> bool {
    match probe_default_monitor() {
        Ok(probe) => {
            tracing::info!(
                source = probe.source_name.as_str(),
                rate_hz = probe.sample_rate_hz,
                "linux system audio monitor available"
            );
            true
        }
        Err(error) => {
            tracing::info!(?error, "linux system audio capture unavailable");
            false
        }
    }
}

/// 探测默认 sink 的 monitor 源。
///
/// 建立与本地服务器的上下文连接，通过 `get_server_info` 拿到默认 sink 名称，
/// 拼接 `<sink>.monitor` 后用 `get_source_info` 确认源存在并读取原生采样率。
///
/// # 返回值
/// 探测成功返回源名称与原生采样率；连接失败、超时或 monitor 源不存在时
/// 返回 [`CaptureError::DeviceUnavailable`]。
fn probe_default_monitor() -> Result<MonitorProbe, CaptureError> {
    let mut mainloop = Mainloop::new().ok_or(CaptureError::DeviceUnavailable)?;
    let mut proplist = Proplist::new().ok_or(CaptureError::DeviceUnavailable)?;
    proplist
        .set_str(properties::APPLICATION_NAME, "mimi")
        .map_err(|_| CaptureError::DeviceUnavailable)?;
    let mut context = Context::new_with_proplist(&mainloop, "mimi-audio", &proplist)
        .ok_or(CaptureError::DeviceUnavailable)?;
    context
        .connect(None, FlagSet::NOFLAGS, None)
        .map_err(|error| {
            tracing::warn!(?error, "failed to connect PulseAudio server");
            CaptureError::DeviceUnavailable
        })?;
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    wait_for_context_ready(&context, &mut mainloop, deadline)?;

    let sink_name = get_default_sink_name(&context, &mut mainloop, deadline)?;
    let monitor_name = format!("{sink_name}.monitor");
    let sample_rate_hz = get_source_sample_rate(&context, &mut mainloop, &monitor_name, deadline)?;
    Ok(MonitorProbe {
        source_name: monitor_name,
        sample_rate_hz,
    })
}

/// 轮询等待 PulseAudio 上下文进入就绪状态。
///
/// # 参数
/// - `context`：已发起连接的上下文。
/// - `mainloop`：驱动上下文事件分发的主循环。
/// - `deadline`：等待超时时刻。
///
/// # 返回值
/// 就绪返回 `Ok(())`；连接失败或超时返回 [`CaptureError::DeviceUnavailable`]。
fn wait_for_context_ready(
    context: &Context,
    mainloop: &mut Mainloop,
    deadline: Instant,
) -> Result<(), CaptureError> {
    loop {
        match context.get_state() {
            ContextState::Ready => return Ok(()),
            ContextState::Failed | ContextState::Terminated => {
                tracing::warn!("PulseAudio context failed to become ready");
                return Err(CaptureError::DeviceUnavailable);
            }
            _ => {}
        }
        if Instant::now() >= deadline {
            tracing::warn!("timeout waiting for PulseAudio context");
            return Err(CaptureError::DeviceUnavailable);
        }
        iterate_mainloop(mainloop)?;
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// 非阻塞分发一次主循环事件。
///
/// # 参数
/// - `mainloop`：标准主循环。
///
/// # 返回值
/// 正常分发返回 `Ok(())`；主循环退出或出错返回
/// [`CaptureError::DeviceUnavailable`]。
fn iterate_mainloop(mainloop: &mut Mainloop) -> Result<(), CaptureError> {
    match mainloop.iterate(false) {
        IterateResult::Success(_) => Ok(()),
        IterateResult::Quit(_) | IterateResult::Err(_) => Err(CaptureError::DeviceUnavailable),
    }
}

/// 阻塞等待单个 introspect 操作完成。
///
/// # 参数
/// - `operation`：待等待的操作。
/// - `mainloop`：驱动操作回调的主循环。
/// - `deadline`：等待超时时刻。
///
/// # 返回值
/// 操作完成返回 `Ok(())`；操作被取消或超时返回
/// [`CaptureError::DeviceUnavailable`]。
fn wait_for_operation<T: ?Sized>(
    operation: &Operation<T>,
    mainloop: &mut Mainloop,
    deadline: Instant,
) -> Result<(), CaptureError> {
    loop {
        match operation.get_state() {
            OperationState::Done => return Ok(()),
            OperationState::Cancelled => return Err(CaptureError::DeviceUnavailable),
            OperationState::Running => {}
        }
        if Instant::now() >= deadline {
            tracing::warn!("timeout waiting for PulseAudio introspection");
            return Err(CaptureError::DeviceUnavailable);
        }
        iterate_mainloop(mainloop)?;
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// 查询服务器当前默认 sink 名称。
///
/// # 参数
/// - `context`：已就绪的上下文。
/// - `mainloop`：驱动回调的主循环。
/// - `deadline`：等待超时时刻。
///
/// # 返回值
/// 查询成功返回默认 sink 名称，失败或超时返回
/// [`CaptureError::DeviceUnavailable`]。
fn get_default_sink_name(
    context: &Context,
    mainloop: &mut Mainloop,
    deadline: Instant,
) -> Result<String, CaptureError> {
    let sink_name = Rc::new(RefCell::new(None::<String>));
    let cb_sink_name = Rc::clone(&sink_name);
    let operation = context.introspect().get_server_info(move |info| {
        if let Some(name) = &info.default_sink_name {
            *cb_sink_name.borrow_mut() = Some(name.to_string());
        }
    });
    wait_for_operation(&operation, mainloop, deadline)?;
    let reported_sink_name = sink_name.borrow().clone();
    reported_sink_name.ok_or_else(|| {
        tracing::warn!("PulseAudio server did not report default sink");
        CaptureError::DeviceUnavailable
    })
}

/// 查询采集源的原生采样率，用于确认 `<sink>.monitor` 存在。
///
/// # 参数
/// - `context`：已就绪的上下文。
/// - `mainloop`：驱动回调的主循环。
/// - `source_name`：待查询的源名称。
/// - `deadline`：等待超时时刻。
///
/// # 返回值
/// 源存在时返回其原生采样率；源不存在或查询失败返回
/// [`CaptureError::DeviceUnavailable`]。
fn get_source_sample_rate(
    context: &Context,
    mainloop: &mut Mainloop,
    source_name: &str,
    deadline: Instant,
) -> Result<u32, CaptureError> {
    let sample_rate = Rc::new(RefCell::new(None::<u32>));
    let cb_sample_rate = Rc::clone(&sample_rate);
    let operation = context
        .introspect()
        .get_source_info_by_name(source_name, move |result| {
            if let ListResult::Item(info) = result {
                *cb_sample_rate.borrow_mut() = Some(info.sample_spec.rate);
            }
        });
    wait_for_operation(&operation, mainloop, deadline)?;
    let reported_sample_rate = *sample_rate.borrow();
    reported_sample_rate.ok_or_else(|| {
        tracing::warn!(source = source_name, "monitor source not found");
        CaptureError::DeviceUnavailable
    })
}

/// 打开 monitor 采集流。
///
/// 先探测默认 sink monitor，再按 S16LE 立体声（优先原生速率，异常时回退
/// 48 kHz）用 pa_simple 打开录制流。
///
/// # 返回值
/// 成功返回 pa_simple 句柄与采集流实际采样率；失败返回分类错误。
fn open_capture_stream() -> Result<(psimple::Simple, u32), CaptureError> {
    let probe = probe_default_monitor()?;
    let sample_rate_hz =
        if (MIN_NATIVE_RATE_HZ..=MAX_NATIVE_RATE_HZ).contains(&probe.sample_rate_hz) {
            probe.sample_rate_hz
        } else {
            tracing::warn!(
                native_rate_hz = probe.sample_rate_hz,
                "monitor native rate out of range; falling back"
            );
            DEFAULT_CAPTURE_RATE_HZ
        };
    let spec = Spec {
        format: Format::S16le,
        channels: CAPTURE_CHANNELS,
        rate: sample_rate_hz,
    };
    let simple = psimple::Simple::new(
        None,
        "mimi-audio",
        Direction::Record,
        Some(probe.source_name.as_str()),
        "mimi system audio",
        &spec,
        None,
        None,
    )
    .map_err(|error| {
        tracing::warn!(
            ?error,
            source = probe.source_name.as_str(),
            "failed to open monitor stream"
        );
        CaptureError::DeviceUnavailable
    })?;
    Ok((simple, sample_rate_hz))
}

/// 计算单次读取块的采样帧数。
///
/// # 参数
/// - `sample_rate_hz`：采集流采样率。
///
/// # 返回值
/// 一个读取块包含的帧数。
fn frames_per_block(sample_rate_hz: u32) -> usize {
    (sample_rate_hz as usize * READ_BLOCK.as_millis() as usize) / 1000
}

/// 把一段小端 S16LE 交错字节解码为 f32 采样。
///
/// # 参数
/// - `bytes`：小端 S16LE 交错采样字节，长度需为偶数。
///
/// # 返回值
/// 归一化到 -1.0 到 1.0 的 f32 采样序列。
fn bytes_to_f32_interleaved(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32_768.0)
        .collect()
}

/// 采集读取主循环：阻塞读取 monitor 数据并降混、重采样后送入输出队列。
///
/// 暂停时丢弃音频；输出队列连续塞满或读取失败时按共享范式上报并退出。
/// 循环结束后 `simple` 被 drop，释放录制流与底层连接。
///
/// # 参数
/// - `simple`：已打开的 monitor 录制流。
/// - `sink`：PCM16 单声道采样输出通道。
/// - `paused`：暂停标志。
/// - `running`：运行标志。
/// - `errors`：运行期间设备故障的错误发送端。
/// - `resampler`：流式降混重采样器。
/// - `sample_rate_hz`：采集流实际采样率。
fn run_read_loop(
    simple: psimple::Simple,
    sink: tokio::sync::mpsc::Sender<Vec<i16>>,
    paused: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    errors: tokio::sync::mpsc::UnboundedSender<CaptureError>,
    resampler: &mut StreamingPcm16Resampler,
    sample_rate_hz: u32,
) {
    let block_bytes =
        frames_per_block(sample_rate_hz) * CAPTURE_CHANNELS as usize * std::mem::size_of::<i16>();
    let mut consecutive_sink_fulls = 0;
    while running.load(Ordering::SeqCst) {
        let mut block = vec![0_u8; block_bytes];
        if let Err(error) = simple.read(&mut block) {
            tracing::warn!(?error, "system audio monitor read failed");
            super::report_unexpected_capture_failure(
                &running,
                &errors,
                CaptureError::DeviceUnavailable,
            );
            break;
        }
        if !running.load(Ordering::SeqCst) {
            break;
        }
        if paused.load(Ordering::SeqCst) {
            continue;
        }
        let samples = bytes_to_f32_interleaved(&block);
        match resampler.push_interleaved(&samples) {
            Ok(buffers) => {
                for pcm in buffers {
                    if pcm.is_empty() {
                        continue;
                    }
                    if super::handle_capture_sink_result(
                        sink.try_send(decode_i16(&pcm)),
                        &mut consecutive_sink_fulls,
                        &running,
                        &errors,
                        "system audio",
                    ) {
                        return;
                    }
                }
            }
            Err(error) => {
                tracing::warn!(?error, "system audio resample failed");
            }
        }
    }
}
