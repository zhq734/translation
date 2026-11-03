(() => {
  "use strict";

  const commands = {
    unix: "curl -fsSL https://raw.githubusercontent.com/zhq734/translation/master/scripts/install.sh | sh",
    windows: "irm https://raw.githubusercontent.com/zhq734/translation/master/scripts/install.ps1 | iex"
  };

  const tabs = [...document.querySelectorAll("[data-command]")];
  const output = document.querySelector("#install-command");
  const copy = document.querySelector("#copy-command");
  const tocLinks = [...document.querySelectorAll(".toc a")];
  const sections = tocLinks.map((link) => document.querySelector(link.getAttribute("href"))).filter(Boolean);

  /**
   * 绑定安装命令平台切换事件。
   * 创建者：zhenghq
   * @returns {void}
   */
  const initCommandTabs = () => {
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const command = commands[tab.dataset.command];
        if (!command || !output) return;
        tabs.forEach((item) => item.setAttribute("aria-pressed", String(item === tab)));
        output.textContent = command;
      });
    });
  };

  /**
   * 绑定复制安装命令按钮并保留按钮图标。
   * 创建者：zhenghq
   * @returns {void}
   */
  const initCopyCommand = () => {
    copy?.addEventListener("click", async () => {
      if (!output) return;
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
   * 监听文档滚动并高亮当前目录项。
   * 创建者：zhenghq
   * @returns {void}
   */
  const initTableOfContents = () => {
    if (!("IntersectionObserver" in window) || !sections.length) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      tocLinks.forEach((link) => link.classList.toggle("is-active", link.getAttribute("href") === `#${visible.target.id}`));
    }, { rootMargin: "-18% 0px -65% 0px", threshold: [0, .1, .35] });
    sections.forEach((section) => observer.observe(section));
  };

  initCommandTabs();
  initCopyCommand();
  initTableOfContents();
})();
