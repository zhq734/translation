# 自建 DeepLX 部署指南（零费用）

自建 DeepLX 后，本应用的翻译会**优先走本地自建实例**（限流少、稳定），公共 DeepLX、Google、MyMemory 只作兜底。

> 默认本机端口 `1188` 常被代理类软件（Clash 等）占用，本文档统一用 **`1189`** 端口映射，避免冲突。

> ⚠️ 说明：DeepLX 是开源免费软件，它复用 **DeepL 网页版免费额度**（注册免费，约 50 万字符/月）。这属于「非官方」方式，若 DeepL 改版可能短期失效（社区一般会跟进更新）。个人划词使用完全够用。

## 费用

- DeepLX 软件：免费开源（<https://github.com/OwO-Network/DeepLX>）
- DeepL 账号：免费版即可（约 50 万字符/月）
- 部署：本机 Docker 运行，**零服务器费用**

## 步骤 1：注册 DeepL 免费账号

1. 打开 <https://www.deepl.com/pro>，注册并登录（普通免费账号即可，**不需要**付费 API）。

## 步骤 2：获取 DeepL 的 Token

登录后，从浏览器里取 `dl_session`（登录凭证）：

1. 用浏览器登录 DeepL 网页版。
2. 打开开发者工具（`F12` 或 `⌥⌘I`）→ **Application / 应用** 标签 → **Cookies** → `https://www.deepl.com`。
3. 找到名为 `dl_session` 的 Cookie，复制它的值（一长串）。

> 不同时期 DeepL 改版可能影响取 token 方式，若找不到 `dl_session`，请以 [DeepLX 官方 README](https://github.com/OwO-Network/DeepLX) 的最新说明为准。

## 步骤 3：用 Docker 启动 DeepLX

把上一步的 `dl_session` 值替换到 `TOKEN=` 后面：

```bash
docker run -d \
  --name deeplx \
  --restart unless-stopped \
  -p 1189:1188 \
  -e TOKEN=你的dl_session值 \
  ghcr.io/owo-network/deeplx:latest
```

> 国内拉镜像慢的话，可先 `docker pull` 时配置镜像加速，或用源码编译（见官方 README）。

## 步骤 4：验证

```bash
curl -X POST http://127.0.0.1:1189/translate \
  -H "Content-Type: application/json" \
  -d '{"text":"hello","source_lang":"en","target_lang":"zh"}'
```

返回类似 `{"code":200,"data":"你好",...}` 即成功。

## 步骤 5：接入本应用

1. 点击菜单栏「译」图标 → **设置…**。
2. 在「自建 DeepLX」区块，把**服务地址**填为 `http://127.0.0.1:1189/translate`（改动自动保存）。
3. 点「检测是否在线」，显示「✓ 在线」即接入成功。

> 自建端点默认是**关闭**的（`deepLxUrl` 为空）；填上地址后 15 秒熔断冷却结束即自动生效（也可重启应用立即生效）。

划词翻译时悬浮窗顶部若显示 `· 自建 DeepLX`，说明已走本地通道；若显示 `· 公共 DeepLX` / `· Google` / `· MyMemory`，说明本地实例未生效（检查容器是否在跑、端口是否被占用）。

若你的 DeepLX 部署在别处（其他机器 / 端口 / 域名），把「服务地址」改成对应地址，例如 `http://192.168.1.10:1189/translate`。
