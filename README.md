# dsh-scihub

DeepSeek Harness 插件：按 **DOI 或 URL** 从 Sci-Hub 镜像抓取论文 PDF，保存到当前会话工作区。

> Sci-Hub 是影子图书馆，其可用性与合法性因司法辖区而异。插件只如实报告它实际拿到了什么，不会把失败包装成成功。

## 提供的能力

注册一个模型工具 `scihub_pdf`：

| 参数 | 类型 | 说明 |
|---|---|---|
| `doi` | string | 裸 DOI（`10.1038/nature12373`）或 doi.org 链接 |
| `url` | string | 文章页 / 出版社 DOI 链接 / 直接 PDF 链接 |

`doi` 与 `url` **二选一**，同时给或都不给都会在入口报错。

### `url` 怎么解析

1. URL 里带 DOI（`https://link.springer.com/article/10.1007/...`、`.../doi/pdf/10.1016/...`）→ 抽出 DOI，走镜像。
2. 路径以 `.pdf` 结尾（`https://host/paper.pdf`）→ 先**直连下载**；若对方吐回 HTML（付费墙 / 只有 cookie 才给文件）且链接里同时有 DOI，则转走镜像。
3. 其它文章页（`https://www.nature.com/articles/s41586-020-2649-2`）→ 抓一次页面，取 `citation_doi` meta（或页面上第一个 DOI），再走镜像。

第 3 条只多花一次抓取，但能覆盖 Nature/Science 这类 URL 里不含 DOI 的站点。

### 返回的 `status`

| status | 含义 |
|---|---|
| `downloaded` | 已写入 `<工作区>/scihub/<name>.pdf`，给出 `path` / `bytes` / `title` / `mirror` / `pdfUrl` |
| `not_found` | 所有镜像都没有这篇文章 |
| `challenge` | 至少一个镜像返回 Cloudflare Turnstile 人机验证；纯 HTTP 客户端过不去，**无法确认文章是否存在**，所以不能报 not_found |
| `error` | 网络 / HTTP / 拿回来的不是 PDF，`message` 与 `attempts` 里写原因 |

## 实现要点

- 镜像列表（2026-10-29 实测，24 个候选域名逐个验证到真能吐出 `%PDF`）：`sci-hub.usualwant.com` → `sci-hub.ee` → `sci-hub.in` → `sci-hub.ren`。
- 上一次成功的镜像会被提到最前面，所以列表里哪天死一个，只会在第一次请求时白跑一趟，之后不再付这个代价。
- `sci-hub.jp`（最初指定的域名）已确认是停放站：任何路径都返回 610 字节纯广告壳，**已从列表移除**。
- 其余候选的死法：`.se .ink .io .work .tech .3800808.xyz .nsm.plus` 无 DNS；`.st .box .mksa.top` 是 DDoS-Guard 403；`.wf` 503；`.ru` 是 Cloudflare「are you a robot」；`.tf` 404、`.cat` 501、`.pub .help .li .tw` 超时/重置；`.ist` 同为停放壳。
- 文章页的 PDF 链接来自 `<embed id="pdf" src="...">`；页面「save」按钮里那份 JSON 转义的同一链接（`\/`）也会被解析。
- 下载后校验 `%PDF-` 魔数；命中 HTML 广告页或验证页一律判失败，不落盘。
- 只依赖 `node:` 内置模块（`node:https` / `node:http` / `node:fs/promises` / `node:path`），无第三方依赖。
- 输出目录通过 `workingDirectory` 服务解析，取不到时退到该服务的默认目录。
- 文件名：走 DOI 时用 `<doi 压平>.pdf`，直连时用 URL 最后一段。
- 镜像存活是今天的快照；下载开始失败时跑 `node probe-mirrors.mjs` 重测，把结果贴回 `MIRRORS`。

## 安装

```bash
# 在任意工作区目录
plugin_manager install_bundle target=<本目录绝对路径>
```

或手工：把本目录链接进 profile，然后在 `cordis.patch.yml` 里加

```yaml
- insert:
    - id: scihub
      name: 'dsh-scihub'
```

改了 `lib/host.mjs` 之后需要重启 DSH：profile 里的插件模块按「一次加载」的模块代存在，不是改文件即刻生效。

## 自测

```bash
node test-smoke.mjs                          # 默认 10.1038/nature12373
node test-smoke.mjs 10.1103/PhysRevLett.116.061102
```

一条最小端到端检查，覆盖五种输入与五种非法输入：

- `doi`（doi.org 链接，须归一化成裸 DOI）
- `url` 自带 DOI
- `url` 是直连 `.pdf`
- `url` 是文章页，DOI 只在 `citation_doi` meta 里（本地起 HTTP 服务模拟，离线确定性）
- `.pdf` 链接却返回 HTML → 必须报 `error`，不能算下载成功
- 两参数同时给 / 都不给 / 非法 DOI / `ftp://` / 非 URL → 全部在入口拒绝
