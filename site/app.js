(() => {
  "use strict";

  const services = {
    ai: {
      symbol: "◇ LOCAL OR CLOUD",
      title: "接上你的模型。",
      description: "支持 Ollama、OpenAI 兼容与 Claude Code（Anthropic）兼容协议。API Key 通过系统安全存储加密，不写入公开设置或日志。",
      tags: ["Ollama", "OpenAI 兼容", "Claude Code"],
      footnote: "可在线检测端点与模型，并自动拉取模型列表。服务费用与数据处理方式由你选择的服务商决定。"
    },
    deeplx: {
      symbol: "◇ SELF-HOSTED",
      title: "把翻译留在自己的网络里。",
      description: "填写自建 DeepLX 的 /translate 地址，即可作为稳定翻译通道。设置页可在线检测服务，并生成 Docker 部署命令。",
      tags: ["自建服务", "Docker", "内网可用"],
      footnote: "公共 DeepLX 仍会作为默认兜底，但可能限流。长期使用建议部署自己的服务并配置代理绕过规则。"
    },
    dingtalk: {
      symbol: "◇ ENTERPRISE",
      title: "接上企业自己的翻译。",
      description: "配置钉钉企业内部应用的 CorpId、ClientId 与 ClientSecret，使用已开通的 AI 文本翻译能力。",
      tags: ["CorpId", "ClientId", "AI 文本翻译"],
      footnote: "ClientSecret 使用 Electron safeStorage 加密保存，不写入公开设置或日志。配置失败时会自动降级到后续通道。"
    },
    microsoft: {
      symbol: "◇ NO API KEY",
      title: "免密钥，直接可用。",
      description: "通过 Bing 网页翻译链路提供翻译能力，无需 Azure 账号、订阅密钥或 Region。启用后可参与自动降级。",
      tags: ["无需密钥", "Bing", "自动降级"],
      footnote: "该能力使用非官方网页接口，可能随 Bing 页面或反滥用策略调整而失效。正式业务建议使用官方 API 或自建服务。"
    }
  };

  const commands = {
    unix: "curl -fsSL https://raw.githubusercontent.com/zhq734/translation/master/scripts/install.sh | sh",
    windows: "irm https://raw.githubusercontent.com/zhq734/translation/master/scripts/install.ps1 | iex"
  };

  /**
   * 将指定选择器对应元素的文本更新为给定内容。
   * 创建者：zhenghq
   * @param {string} selector CSS 选择器
   * @param {string} value 新文本
   * @returns {void}
   */
  const setText = (selector, value) => {
    const element = document.querySelector(selector);
    if (element) element.textContent = value;
  };

  /**
   * 初始化翻译服务切换交互。
   * 创建者：zhenghq
   * @returns {void}
   */
  const initServices = () => {
    const buttons = [...document.querySelectorAll("[data-service]")];
    if (!buttons.length) return;
    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        const service = services[button.dataset.service];
        if (!service) return;
        buttons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
        setText("#service-symbol", service.symbol);
        setText("#service-title", service.title);
        setText("#service-description", service.description);
        setText("#service-footnote", service.footnote);
        const tags = document.querySelector("#service-tags");
        if (tags) {
          tags.replaceChildren(...service.tags.map((tag) => {
            const span = document.createElement("span");
            span.textContent = tag;
            return span;
          }));
        }
      });
    });
  };

  /**
   * 初始化安装命令切换与复制交互。
   * 创建者：zhenghq
   * @returns {void}
   */
  const initCommands = () => {
    const tabs = [...document.querySelectorAll("[data-command]")];
    const output = document.querySelector("#install-command");
    const copy = document.querySelector("#copy-command");
    if (!tabs.length || !output) return;
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const command = commands[tab.dataset.command];
        if (!command) return;
        tabs.forEach((item) => item.setAttribute("aria-pressed", String(item === tab)));
        output.textContent = command;
      });
    });
    copy?.addEventListener("click", async () => {
      const label = copy.querySelector("span");
      try {
        await navigator.clipboard.writeText(output.textContent.trim());
        if (label) label.textContent = "已复制";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(output);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        if (label) label.textContent = "请复制";
      }
      window.setTimeout(() => { if (label) label.textContent = "复制"; }, 1800);
    });
  };

  /**
   * 检测当前操作系统并高亮对应下载卡片。
   * 创建者：zhenghq
   * @returns {void}
   */
  const detectPlatform = () => {
    const platform = `${navigator.userAgentData?.platform || ""} ${navigator.platform || ""} ${navigator.userAgent || ""}`.toLowerCase();
    const key = platform.includes("mac") ? "mac" : platform.includes("win") ? "win" : platform.includes("linux") ? "linux" : "";
    const card = key ? document.querySelector(`[data-platform="${key}"]`) : null;
    if (!card) return;
    card.classList.add("is-detected");
    const badge = card.querySelector(".platform-badge");
    if (badge) badge.textContent = "当前系统";
  };

  /**
   * 根据页面滚动位置更新主导航的当前章节状态。
   * 创建者：zhenghq
   * @returns {void}
   */
  const initActiveNavigation = () => {
    const navLinks = [...document.querySelectorAll(".site-nav a[href^='#']")];
    const sections = navLinks.map((link) => document.querySelector(link.getAttribute("href"))).filter(Boolean);
    if (!navLinks.length || !sections.length || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      navLinks.forEach((link) => link.toggleAttribute("aria-current", link.getAttribute("href") === `#${visible.target.id}`));
    }, { rootMargin: "-22% 0px -60% 0px", threshold: [0, .15, .4] });
    sections.forEach((section) => observer.observe(section));
  };

  initServices();
  initCommands();
  detectPlatform();
  initActiveNavigation();
})();
