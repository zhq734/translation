//! partial/final 文本归并状态机。
//!
//! 移植自 Mimi 的 `shared/mimi-core/src/subtitle_reducer.rs`（MIT，Copyright (c)
//! 2026 yuxino），只保留实时字幕所需的“partial 覆盖当前草稿、final 提交并
//! 开启新段落”语义。翻译与双语配对由 Electron 主进程的 JS 管道负责，
//! 因此这里不保留翻译配对、历史归档等能力。

/// 归并后的文本事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReducedEvent {
    /// 临时草稿：覆盖当前段落预览。
    Partial(String),
    /// 已提交文本：固化段落并开启新段落。
    Final(String),
    /// 文本与上一次输出相同，调用方可跳过。
    Unchanged,
}

/// partial/final 文本归并状态机。
#[derive(Debug, Default)]
pub struct SubtitleReducer {
    /// 当前未提交的草稿原文。
    draft: String,
    /// 上一次对外输出的文本，用于去重。
    last_emitted: String,
}

impl SubtitleReducer {
    /// 创建空的归并状态机。
    ///
    /// # 返回值
    /// 全新的 reducer 实例。
    pub fn new() -> Self {
        Self::default()
    }

    /// 处理一条临时识别文本。
    ///
    /// 连续相同的 partial 会被判定为 [`ReducedEvent::Unchanged`]，避免下游重复渲染。
    ///
    /// # 参数
    /// - `text`：提供商返回的临时识别文本。
    ///
    /// # 返回值
    /// 需要对外发送的归并事件。
    pub fn push_partial(&mut self, text: &str) -> ReducedEvent {
        if text.is_empty() || text == self.draft {
            return ReducedEvent::Unchanged;
        }
        self.draft = text.to_string();
        if text == self.last_emitted {
            return ReducedEvent::Unchanged;
        }
        self.last_emitted = text.to_string();
        ReducedEvent::Partial(text.to_string())
    }

    /// 处理一条已提交的识别文本。
    ///
    /// final 会覆盖草稿并清空当前段落。片段是否重复应由 ASR 适配层依据
    /// 服务端时间片、item ID 等片段身份判断，不能仅比较文本；否则用户
    /// 连续说出的相同短句会被错误吞掉。
    ///
    /// # 参数
    /// - `text`：提供商提交的稳定识别文本。
    ///
    /// # 返回值
    /// 需要对外发送的归并事件。
    pub fn push_final(&mut self, text: &str) -> ReducedEvent {
        if text.is_empty() {
            return ReducedEvent::Unchanged;
        }
        self.draft.clear();
        self.last_emitted = text.to_string();
        ReducedEvent::Final(text.to_string())
    }

    /// 清空状态，用于会话停止或重启。
    ///
    /// # 返回值
    /// 无返回值。
    pub fn reset(&mut self) {
        self.draft.clear();
        self.last_emitted.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consecutive_partials_do_not_duplicate() {
        let mut reducer = SubtitleReducer::new();
        assert_eq!(
            reducer.push_partial("hello"),
            ReducedEvent::Partial("hello".into())
        );
        assert_eq!(reducer.push_partial("hello"), ReducedEvent::Unchanged);
        assert_eq!(
            reducer.push_partial("hello wor"),
            ReducedEvent::Partial("hello wor".into())
        );
    }

    #[test]
    fn final_clears_draft_and_commits() {
        let mut reducer = SubtitleReducer::new();
        reducer.push_partial("hello wor");
        assert_eq!(
            reducer.push_final("hello world"),
            ReducedEvent::Final("hello world".into())
        );
    }

    #[test]
    fn consecutive_identical_finals_are_distinct_recognitions() {
        let mut reducer = SubtitleReducer::new();
        assert_eq!(
            reducer.push_final("thank you"),
            ReducedEvent::Final("thank you".into())
        );
        assert_eq!(
            reducer.push_final("thank you"),
            ReducedEvent::Final("thank you".into())
        );
    }

    #[test]
    fn empty_text_is_ignored() {
        let mut reducer = SubtitleReducer::new();
        assert_eq!(reducer.push_partial(""), ReducedEvent::Unchanged);
        assert_eq!(reducer.push_final(""), ReducedEvent::Unchanged);
    }

    #[test]
    fn reset_allows_repeated_text_in_new_session() {
        let mut reducer = SubtitleReducer::new();
        reducer.push_final("hello");
        assert_eq!(
            reducer.push_final("hello"),
            ReducedEvent::Final("hello".into())
        );
        reducer.reset();
        assert_eq!(
            reducer.push_final("hello"),
            ReducedEvent::Final("hello".into())
        );
    }
}
