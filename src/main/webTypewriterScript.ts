/** 页面打字机动画参数。 */
export interface WebTypewriterTuning {
  /** 每次揭示后的等待毫秒数。 */
  intervalMs: number
  /** 每次揭示的字符数。 */
  step: number
}

/**
 * 根据文本长度和是否缓存命中计算页面打字机参数，长文本自动加速。
 * @param textLength 完整译文长度。
 * @param cached 是否来自页面缓存。
 * @returns 页面打字机参数。
 * @author zhenghq
 */
export function resolveWebTypewriterTuning(textLength: number, cached: boolean): WebTypewriterTuning {
  if (cached) return { intervalMs: 6, step: textLength > 120 ? 3 : 2 }
  if (textLength > 600) return { intervalMs: 8, step: 4 }
  if (textLength > 200) return { intervalMs: 12, step: 2 }
  return { intervalMs: 18, step: 1 }
}

/**
 * 构造页面侧打字机运行时初始化与取消脚本片段，供原位写回和对照注入复用。
 * @returns 可嵌入 executeJavaScript 脚本的运行时片段。
 * @author zhenghq
 */
export function buildWebTypewriterRuntimeSnippet(): string {
  return `
    const typewriterKey = '__selectionTranslatorTypewriter';
    const typewriter = window[typewriterKey] || (window[typewriterKey] = {
      generation: 0,
      timers: new Map(),
      restoreTimer: null,
      cancel() {
        this.generation += 1;
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        if (this.restoreTimer) clearTimeout(this.restoreTimer);
        this.restoreTimer = null;
        const pageState = window.__selectionTranslatorWebTranslation;
        if (pageState) pageState.suppressed = false;
      }
    });
    const scheduleTypewriter = (key, apply, fullText, tuning) => {
      const previous = typewriter.timers.get(key);
      if (previous) clearTimeout(previous);
      typewriter.timers.delete(key);
      const generation = typewriter.generation;
      let visible = 0;
      const tick = () => {
        if (generation !== typewriter.generation) return;
        visible = Math.min(fullText.length, visible + Math.max(1, tuning.step || 1));
        apply(fullText.slice(0, visible));
        if (visible < fullText.length) {
          const timer = setTimeout(tick, Math.max(1, tuning.intervalMs || 1));
          typewriter.timers.set(key, timer);
        } else {
          typewriter.timers.delete(key);
        }
      };
      if (fullText.length === 0) {
        apply('');
        return;
      }
      tick();
    };
  `
}

/**
 * 构造取消全部页面打字机动画的脚本，导航或任务失效时调用。
 * @returns 可传给 executeJavaScript 的脚本字符串。
 * @author zhenghq
 */
export function buildWebTypewriterCancelScript(): string {
  return `(() => {
    const typewriter = window.__selectionTranslatorTypewriter;
    if (!typewriter) return false;
    for (const timer of typewriter.timers.values()) clearTimeout(timer);
    typewriter.timers.clear();
    if (typewriter.restoreTimer) clearTimeout(typewriter.restoreTimer);
    typewriter.restoreTimer = null;
    typewriter.cancel();
    return true;
  })()`
}
