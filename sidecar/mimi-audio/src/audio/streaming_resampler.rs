//! 流式多声道降混与重采样。
//!
//! 移植自 Mimi 的 `src-tauri/src/audio/streaming_resampler.rs`（MIT，
//! Copyright (c) 2026 yuxino），把输出改为 i16 采样，并复用本 crate 的
//! [`CaptureError`] 错误分类。回调可传入任意长度，未组成完整帧或完整重采样
//! 块的采样会保留到下一次调用。

use rubato::audioadapter_buffers::direct::SequentialSlice;
use rubato::{FixedSync, Resampler};

use super::pcm::Pcm16Encoder;
use super::CaptureError;

/// 单次重采样处理的帧数。
const RESAMPLE_CHUNK_FRAMES: usize = 1024;

/// 有状态的交错音频降混与重采样器。
pub struct StreamingPcm16Resampler {
    /// 输入声道数。
    channel_count: usize,
    /// 输入采样率。
    input_sample_rate_hz: u32,
    /// 目标采样率。
    target_sample_rate_hz: u32,
    /// 未组成完整帧的交错采样。
    pending_interleaved: Vec<f32>,
    /// 未处理完的单声道采样。
    pending_mono: Vec<f32>,
    /// 采样率不同时启用的重采样器。
    resampler: Option<rubato::Fft<f32>>,
}

impl StreamingPcm16Resampler {
    /// 创建流式重采样器。
    ///
    /// # 参数
    /// - `input_sample_rate_hz`：输入采样率。
    /// - `target_sample_rate_hz`：目标采样率。
    /// - `channel_count`：输入声道数。
    ///
    /// # 返回值
    /// 重采样器；参数非法或重采样器构造失败时返回错误。
    pub fn new(
        input_sample_rate_hz: u32,
        target_sample_rate_hz: u32,
        channel_count: usize,
    ) -> Result<Self, CaptureError> {
        if channel_count == 0 || input_sample_rate_hz == 0 || target_sample_rate_hz == 0 {
            return Err(CaptureError::Unsupported);
        }
        let resampler = if input_sample_rate_hz == target_sample_rate_hz {
            None
        } else {
            Some(
                rubato::Fft::<f32>::new(
                    input_sample_rate_hz as usize,
                    target_sample_rate_hz as usize,
                    RESAMPLE_CHUNK_FRAMES,
                    1,
                    FixedSync::Input,
                )
                .map_err(|_| CaptureError::Unsupported)?,
            )
        };
        Ok(Self {
            channel_count,
            input_sample_rate_hz,
            target_sample_rate_hz,
            pending_interleaved: Vec::new(),
            pending_mono: Vec::new(),
            resampler,
        })
    }

    /// 推入一段交错 f32 采样，输出已重采样的 PCM16 单声道字节。
    ///
    /// # 参数
    /// - `data`：交错排列的 f32 采样。
    ///
    /// # 返回值
    /// 本次可输出的 PCM16 字节块；尚无完整输出时返回空向量。
    pub fn push_interleaved(&mut self, data: &[f32]) -> Result<Vec<Vec<u8>>, CaptureError> {
        self.pending_interleaved.extend_from_slice(data);
        let complete_sample_count =
            self.pending_interleaved.len() / self.channel_count * self.channel_count;
        if complete_sample_count > 0 {
            let channel_count = self.channel_count;
            self.pending_mono.extend(
                self.pending_interleaved[..complete_sample_count]
                    .chunks_exact(channel_count)
                    .map(|frame| frame.iter().copied().sum::<f32>() / channel_count as f32),
            );
            self.pending_interleaved.drain(..complete_sample_count);
        }

        if self.input_sample_rate_hz == self.target_sample_rate_hz {
            if self.pending_mono.is_empty() {
                return Ok(Vec::new());
            }
            let pcm = Pcm16Encoder::encode(std::slice::from_ref(&self.pending_mono));
            self.pending_mono.clear();
            return Ok(vec![pcm]);
        }

        let Some(resampler) = self.resampler.as_mut() else {
            return Err(CaptureError::Unsupported);
        };
        let mut buffers = Vec::new();
        while self.pending_mono.len() >= RESAMPLE_CHUNK_FRAMES {
            let output = match SequentialSlice::new(
                &self.pending_mono[..RESAMPLE_CHUNK_FRAMES],
                1,
                RESAMPLE_CHUNK_FRAMES,
            ) {
                Ok(input) => resampler
                    .process(&input, None)
                    .map(|output| output.take_data())
                    .map_err(|_| CaptureError::Unsupported),
                Err(_) => Err(CaptureError::Unsupported),
            };
            self.pending_mono.drain(..RESAMPLE_CHUNK_FRAMES);
            let output = output?;
            let pcm = Pcm16Encoder::encode(&[output]);
            if !pcm.is_empty() {
                buffers.push(pcm);
            }
        }
        Ok(buffers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::pcm::decode_i16;

    /// 生成从指定帧开始、48 kHz 采样率下的立体声 1 kHz 正弦波。
    ///
    /// # 参数
    /// - `start_frame`：起始帧序号。
    /// - `frame_count`：帧数。
    ///
    /// # 返回值
    /// 交错立体声采样。
    fn stereo_sine(start_frame: usize, frame_count: usize) -> Vec<f32> {
        (start_frame..start_frame + frame_count)
            .flat_map(|frame| {
                let sample = (frame as f64 * 2.0 * std::f64::consts::PI * 1_000.0 / 48_000.0).sin()
                    as f32
                    * 0.5;
                [sample, sample]
            })
            .collect()
    }

    #[test]
    fn four_small_callbacks_fill_one_resampler_block() {
        let mut resampler = StreamingPcm16Resampler::new(48_000, 24_000, 2).unwrap();
        for callback in 0..3 {
            assert!(resampler
                .push_interleaved(&stereo_sine(callback * 256, 256))
                .unwrap()
                .is_empty());
        }
        let output = resampler
            .push_interleaved(&stereo_sine(3 * 256, 256))
            .unwrap();
        assert!(!output.is_empty());
        assert!(output.iter().map(Vec::len).sum::<usize>() > 0);
    }

    #[test]
    fn incomplete_interleaved_frames_are_buffered() {
        let mut resampler = StreamingPcm16Resampler::new(24_000, 24_000, 2).unwrap();
        assert!(resampler.push_interleaved(&[0.5]).unwrap().is_empty());
        let output = resampler.push_interleaved(&[0.5]).unwrap();
        assert_eq!(output.len(), 1);
        assert_eq!(decode_i16(&output[0]), vec![16384]);
    }

    #[test]
    fn same_rate_downsamples_channels_without_resampling() {
        let mut resampler = StreamingPcm16Resampler::new(16_000, 16_000, 2).unwrap();
        let output = resampler.push_interleaved(&[1.0, -1.0, 0.5, 0.5]).unwrap();
        assert_eq!(decode_i16(&output[0]), vec![0, 16384]);
    }

    #[test]
    fn zero_rate_is_rejected() {
        assert!(matches!(
            StreamingPcm16Resampler::new(0, 16_000, 1),
            Err(CaptureError::Unsupported)
        ));
        assert!(matches!(
            StreamingPcm16Resampler::new(16_000, 16_000, 0),
            Err(CaptureError::Unsupported)
        ));
    }
}
