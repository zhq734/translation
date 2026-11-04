//! 浮点采样到 PCM16 的编码工具。
//!
//! 移植自 Mimi 的 `shared/mimi-core/src/pcm16.rs`（MIT，Copyright (c) 2026
//! yuxino），只保留实时字幕所需的多声道降混与量化。

/// PCM16 编码器。
pub struct Pcm16Encoder;

impl Pcm16Encoder {
    /// 把多声道 f32 采样按帧平均并量化成小端 PCM16 字节。
    ///
    /// # 参数
    /// - `channels`：每个声道的采样序列，长度可不等，按最短长度对齐。
    ///
    /// # 返回值
    /// 小端序 PCM16 字节；无有效帧时返回空。
    pub fn encode(channels: &[Vec<f32>]) -> Vec<u8> {
        if channels.is_empty() {
            return Vec::new();
        }
        let frame_count = channels.iter().map(Vec::len).min().unwrap_or(0);
        if frame_count == 0 {
            return Vec::new();
        }
        let mut data = Vec::with_capacity(frame_count * 2);
        let channel_count = channels.len() as f32;
        for frame in 0..frame_count {
            let mixed: f32 =
                channels.iter().map(|channel| channel[frame]).sum::<f32>() / channel_count;
            data.extend_from_slice(&Self::quantize(mixed).to_le_bytes());
        }
        data
    }

    /// 把单个浮点采样量化成 i16，正负半轴分别使用 32767/32768。
    ///
    /// # 参数
    /// - `sample`：取值通常在 -1.0 到 1.0 之间的浮点采样。
    ///
    /// # 返回值
    /// 饱和量化后的 i16 采样。
    fn quantize(sample: f32) -> i16 {
        let clamped = sample.clamp(-1.0, 1.0);
        if clamped >= 0.0 {
            (clamped * f32::from(i16::MAX)).round() as i16
        } else {
            (clamped * 32_768.0).round() as i16
        }
    }
}

/// 把单声道 f32 采样直接编码为 PCM16 字节。
///
/// # 参数
/// - `samples`：单声道浮点采样。
///
/// # 返回值
/// 小端序 PCM16 字节。
#[cfg(test)]
pub fn encode_mono(samples: &[f32]) -> Vec<u8> {
    Pcm16Encoder::encode(&[samples.to_vec()])
}

/// 把 PCM16 小端字节解码成 i16 采样。
///
/// # 参数
/// - `bytes`：小端序 PCM16 字节，长度不是 2 的倍数时忽略尾部残字节。
///
/// # 返回值
/// 解码后的 i16 采样序列。
pub fn decode_i16(bytes: &[u8]) -> Vec<i16> {
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|sample| i16::from_le_bytes(*sample))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_produces_no_bytes() {
        assert!(Pcm16Encoder::encode(&[]).is_empty());
        assert!(Pcm16Encoder::encode(&[Vec::new()]).is_empty());
    }

    #[test]
    fn silence_is_zero() {
        assert_eq!(
            decode_i16(&Pcm16Encoder::encode(&[vec![0.0; 4]])),
            vec![0, 0, 0, 0]
        );
    }

    #[test]
    fn full_scale_spans_signed_range() {
        assert_eq!(decode_i16(&encode_mono(&[1.0])), vec![i16::MAX]);
        assert_eq!(decode_i16(&encode_mono(&[-1.0])), vec![i16::MIN]);
        assert_eq!(
            decode_i16(&encode_mono(&[1.5, -1.5])),
            vec![i16::MAX, i16::MIN]
        );
    }

    #[test]
    fn multiple_channels_are_averaged() {
        let bytes = Pcm16Encoder::encode(&[vec![1.0, -1.0], vec![0.0, 0.0]]);
        assert_eq!(decode_i16(&bytes), vec![16384, -16384]);
    }

    #[test]
    fn output_is_little_endian() {
        assert_eq!(encode_mono(&[1.0]), vec![0xFF, 0x7F]);
    }
}
