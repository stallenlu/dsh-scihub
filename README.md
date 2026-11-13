# dsh-scihub

DeepSeek Harness 插件：`scihub_pdf` / `scihub_batch` 按 **DOI 或 URL** 从 Sci-Hub 镜像抓取论文 PDF；`libgen_search` / `libgen_download` 用关键词检索 Library Genesis 并按 MD5 下载书籍或文献。文件保存到当前会话工作区，并按引用/命中元数据起人类可读的统一名字。

> Sci-Hub 与 Library Genesis 都是影子图书馆，其可用性与合法性因司法辖区而异。插件只如实报告它实际拿到了什么，不会把失败包装成成功。

## 分发与收录

本插件同时通过三种渠道分发，任意一种都能装进 DSH：

| 渠道 | 状态 / 地址 |
|---|---|
| **npm 包** | `dsh-scihub@0.5.2` 已发布 → https://www.npmjs.com/package/dsh-scihub |
| **GitHub Release 预构建包** | `v0.5.2` 已附 `dsh-scihub-0.5.2.tgz` → https://github.com/stallenlu/dsh-scihub/releases/tag/v0.5.2 |
| **dshmarket 插件市场** | 已收录进官方目录（收录 PR [#12966](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12966) 已合并），在 Plugins → Plugin Market 搜索 `dsh-scihub` 即可一键安装 |

目录会优先使用已发布的 npm 包，其次作者提供的 Release 预构建 tarball，最后回退到整仓 GitHub 源码。仓库已加 `dsh-plugin` topic，`package.json` 声明 `dsh.bundle` 且 `repository` 指回本仓库，根目录 `cordis.patch.yml` 含 `- insert:` —— 这些是目录投稿的硬性要求。

## 提供的能力

注册四个模型工具（两个 Sci-Hub、两个 LibGen）：

### `scihub_pdf` — 单篇

| 参数 | 类型 | 说明 |
|---|---|---|
| `doi` | string | 裸 DOI（`10.1038/nature12373`）或 doi.org 链接 |
| `url` | string | 文章页 / 出版社 DOI 链接 / 直接 PDF 链接 |

`doi` 与 `url` **二选一**，同时给或都不给都会在入口报错。

### `scihub_batch` — 批量

| 参数 | 类型 | 说明 |
|---|---|---|
| `dois` | string[] | 裸 DOI 列表，最多 50 条 |

逐条走和 `scihub_pdf` 完全一样的镜像流程，返回一个汇总：

| status | 含义 |
|---|---|
| `downloaded` | 全部命中 |
| `partial` | 部分命中，`results` 里逐条给出状态 |
| `failed` | 一条都没命中 |

`counts` 给出 `{total, downloaded, failed}`，`results` 里每条带自己的 `status` / `path` / `mirror` / `attempts`。

### `url` 怎么解析

1. URL 里带 DOI（`https://link.springer.com/article/10.1007/...`、`.../doi/pdf/10.1016/...`）→ 抽出 DOI，走镜像。
2. 路径以 `.pdf` 结尾（`https://host/paper.pdf`）→ 先**直连下载**；若对方吐回 HTML（付费墙 / 只有 cookie 才给文件）且链接里同时有 DOI，则转走镜像。
3. 其它文章页（`https://www.nature.com/articles/s41586-020-2649-2`）→ 抓一次页面，取 `citation_doi` meta（或页面上第一个 DOI），再走镜像。

第 3 条只多花一次抓取，但能覆盖 Nature/Science 这类 URL 里不含 DOI 的站点。

### 返回的 `status`（`scihub_pdf`）

| status | 含义 |
|---|---|
| `downloaded` | 已写入 `<工作区>/scihub/<name>.pdf`，给出 `path` / `bytes` / `title` / `mirror` / `pdfUrl` |
| `not_found` | 所有镜像都没有这篇文章 |
| `challenge` | 至少一个镜像返回 Cloudflare Turnstile 人机验证；纯 HTTP 客户端过不去，**无法确认文章是否存在**，所以不能报 not_found |
| `error` | 网络 / HTTP / 拿回来的不是 PDF，`message` 与 `attempts` 里写原因 |

## LibGen：关键词检索 + 按 MD5 下载

LibGen 与 Sci-Hub 的用法不同：Sci-Hub 是「已知 DOI → 直接拿 PDF」，LibGen 是「关键词 → 命中列表 → 挑一条下载」。所以拆成两个工具，先用 `libgen_search` 搜，再把选中的 `md5`（连同 `extension` 和标题/作者等书目信息）传给 `libgen_download`。

### `libgen_search` — 关键词检索

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string | 书名 / 论文标题 / 作者 / ISBN / DOI 等关键词，如 `Deep Learning Goodfellow` |
| `limit` | integer | 最多返回多少条（1-100，默认 25）；镜像按 25 / 50 / 100 行请求 |

返回每条命中的 `md5`、`title`、`author`、`publisher`、`year`、`language`、`pages`、`size`、`extension`，以及 `mirror` / `count` / `attempts`。镜像逐个尝试，遇到人机验证或占位页如实上报，不会把「没搜到」包装成成功。

### `libgen_download` — 按 MD5 下载

| 参数 | 类型 | 说明 |
|---|---|---|
| `md5` | string | 必填，`libgen_search` 命中里的 32 位 MD5 |
| `extension` | string | 命中里的格式（`pdf` / `epub` / `djvu` …），让保存的文件保留真实扩展名 |
| `title` / `author` / `year` / … | string | 命中里的书目信息，用于生成人类可读文件名 |

流程：`ads.php?md5=` 落地页 → 解析出 `get.php?md5=...&key=...`（key 由该镜像按页签发，只在同一镜像有效，绝不跨 host 跟随，也不允许跳进本地网络）→ 带浏览器 `Referer` 下载真实文件。下载后拒绝 HTML、空响应，以及 `content-length` 声明大于实际字节的截断文件。文件保存到 `<工作区>/libgen/<name>.<ext>`，走和 Sci-Hub 一样的 `fileNameTemplate` 命名与「同名不覆盖」原子写。LibGen 不只有 PDF，所以扩展名按命中信息 / `Content-Disposition` / PDF 魔数依次判定，不硬编码 `.pdf`。

| status | 含义 |
|---|---|
| `downloaded` | 已落盘，给出 `path` / `bytes` / `extension` / `mirror` / `downloadUrl` |
| `not_found` | 镜像上没有这个文件（或落地页没给下载链接） |
| `challenge` | 至少一个镜像返回人机验证页面 |
| `error` | 网络 / HTTP / 拿回来的不是文件，`attempts` 里写原因 |

> LibGen 的镜像存活同样会波动：运行时真源是 `lib/libgen-mirrors.json`，每次调用重读、改完不需要重启 DSH；也可用 `config.libgenMirrors` 覆盖。优先级：`config.libgenMirrors` > `lib/libgen-mirrors.json` > 内置兜底列表。

## 文件名：人类可读的统一命名

0.4.1 起，下载的文件不再一律叫 `10.1038_nature12373.pdf`，而是用 Sci-Hub 文章页 / LibGen 命中里**真实存在**的引用或书目元数据套模板，默认：

```yaml
fileNameTemplate: '{firstAuthor} ({year}) {title}'
```

例如 `Watson (1953) Molecular structure of nucleic acids.pdf`。数据来源优先级：Highwire / Dublin Core 的 `<meta>`（`citation_title`、`citation_author`、`citation_date`、`citation_journal_title` …）→ `<title>Sci-Hub | … | …</title>`；页面里的 `#citation` 块**仅用于补年份**（它的作者/期刊文本无结构，不臆测）。**页面没有的字段一律留空，绝不臆造作者或年份**；整篇都没有可用信息时自动回退到旧版 `<doi 压平>.pdf`，老脚本不受影响。

可用占位符：`{title}` `{year}` `{firstAuthor}` / `{author}` `{authors}` `{journal}` `{doi}` `{stem}`（输入 DOI 或直链末段）`{n}`（批量里补零到两位的位序 `01` `02` …）`{index}`（不补零）`{total}`（批量总数）。缺字段不会留下空括号或多余的 ` - ` 分隔符。

在 profile 的 `cordis.patch.yml` 里自定义，例如给批量下载加序号前缀：

```yaml
- id: scihub
  name: 'dsh-scihub'
  config:
    fileNameTemplate: '{n} {firstAuthor} ({year}) {title}'
```

把 `fileNameTemplate` 设成空字符串 `''`，即可**完全恢复 0.4.0 的 DOI 命名**（`10.1038_nature12373.pdf`、直链用 URL 末段）。

落盘前还会把 Windows 非法字符 `\/:*?"<>|` 换成空格、保留中文与其它 Unicode、压缩重复空白、解码 HTML 实体（含希腊字母与常见符号）、按 **230 字节**截断（保证加上去重后缀和扩展名仍不超过常见文件系统的 255 字节上限）、给 `CON` / `COM1` 这类保留设备名加前缀。**同名文件绝不静默覆盖**：内容完全相同就复用（重跑批量幂等），内容不同则依次追加 ` (2)`、` (3)` …，两篇同名论文都能留下。

## 镜像列表：一键更新

镜像存活是今天的快照，不是永久事实。列表是**数据**，不在代码里：

- 运行时真源是 `lib/mirrors.json`：`{"updatedAt": "...", "mirrors": [...]}`。
- 每次调用都**重新读**这个文件 → 改完立即生效，**不需要重启 DSH**。
- LibGen 有独立的 `lib/libgen-mirrors.json`（同样每次调用重读、可用 `config.libgenMirrors` 覆盖）；`update-mirrors.mjs` 只重测 Sci-Hub 镜像。

一键重测并写回：

```bash
node update-mirrors.mjs                          # 用默认 DOI 10.1038/nature12373 探全部候选
node update-mirrors.mjs --doi 10.1103/PhysRevLett.116.061102
```

脚本对每个候选域名真抓一次文章页、找出内嵌的 PDF 链接、**真下载并校验 `%PDF-` 魔数**，通过的按响应速度排序写回 `lib/mirrors.json`，并打印 before/after 差异。一个都探不到活的就保留原列表并以非零码退出。

### 用配置覆盖

在 profile 的 `cordis.patch.yml` 里给插件加 `config:`：

```yaml
- id: scihub
  name: 'dsh-scihub'
  config:
    mirrors:
      - https://sci-hub.ee
      - https://sci-hub.ren
```

```yaml
    mirrorFile: C:/Users/me/sci-hub-mirrors.json   # 指向别的 { "mirrors": [...] } 文件
    proxy: http://127.0.0.1:7897                # 可选：所有出站请求走这个代理
```

优先级：`config.mirrors` > `config.mirrorFile` > `lib/mirrors.json`。

## 代理：在受限网络里抓取

本机 DNS 被污染、镜像域名直连超时，但系统里有一个可用的 HTTP 代理时，给插件配 `proxy` 即可让**所有**出站请求（Sci-Hub 页面 / PDF、LibGen 检索 / `get.php` 下载、重定向）都走它。用纯 `node:` 内置模块建 CONNECT 隧道，HTTPS 目标在隧道内再做 TLS，零第三方依赖。

优先级与取值：

| 来源 | 说明 |
|---|---|
| `config.proxy` | 显式配置，最优先；例如 `http://127.0.0.1:7897`，可带 `user:pass@` |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | 进程环境变量；`https` 目标优先读 `HTTPS_PROXY`，`http` 目标优先读 `HTTP_PROXY`，都没有则 `ALL_PROXY` |
| `NO_PROXY` | 逗号分隔的豁免名单（`.example.com`、`localhost`、`*`）；命中则不走代理 |
| 都没设 | 直连 |

两个安全细节：**环境变量代理不会劫持字面本地/私网目标**（`127.0.0.1`、`192.168.*` 等），所以离线自测的本地假镜像不会被环境里的代理带偏；只有 `config.proxy` 显式指定时才会连本地代理。派生 URL 的 SSRF 防护照常生效——重定向和页面里刮出的下载链接仍要过 `assertSafeDerivedUrl`，禁止跳进本地网络。

> 代理只解决「连不上」：DNS 污染、TCP 被拦这类问题。上游镜像本身要是已经关站或只回占位页（例如 2026-11 本机探测到的 `libgen.*` 641B nginx 占位页），走代理也下不到文件——这时需要更新 `lib/mirrors.json` / `lib/libgen-mirrors.json` 里真正存活的镜像。

## 速度与稳健性（0.5.2 起）

- **有界并发批量**：`scihub_batch` 用 4 个 worker 并发下载，结果按输入顺序回填（`{n}` 编号仍对应原始位序）。池子刻意小，因为每个在途响应最多缓冲 150 MB。50 篇不再是 100 次串行往返。
- **死镜像跳过**：一次批量里某镜像若在网络层失败或返回 HTTP 5xx，会被记进共享集合，后续论文跳过它；404 和「页面里没有 PDF 链接」是论文级结果，不跳过（换个 DOI 仍可能命中）。并发第一轮会竞态，所以最多按 worker 数各探一次，而不是每篇各探一次。
- **截断拒绝**：`content-length` 声明的长度大于实际收到的字节时判为失败，不把半截 PDF 当成功落盘。Sci-Hub 页面 / 直链 PDF 与 LibGen 下载共用同一个 `truncationReason()` 校验。
- **通用验证墙识别**：`isChallenge()` 除了 Sci-Hub 专有措辞，也认 `Just a moment` / `Attention Required` / `cf-browser-verification` / `cf_chl_` 等通用 Cloudflare 文案，避免把「需要浏览器验证」误报成「没找到文章」。

## 实现要点

- 上一次成功的镜像会被提到最前面，所以列表里哪天死一个，只会在第一次请求时白跑一趟，之后不再付这个代价。
- `sci-hub.jp`（最初指定的域名）已确认是停放站：任何路径都返回 610 字节纯广告壳，**不在列表里**。
- 其余候选的死法：`.se .ink .io .work .tech .3800808.xyz .nsm.plus` 无 DNS；`.st .box .mksa.top` 是 DDoS-Guard 403；`.wf` 503；`.ru` 是 Cloudflare「are you a robot」；`.tf` 404、`.cat` 501、`.pub .help .li .tw` 超时/重置；`.ist` 同为停放壳。
- 文章页的 PDF 链接来自 `<embed id="pdf" src="...">`；页面「save」按钮里那份 JSON 转义的同一链接（`\\\\/`）也会被解析。
- 下载后校验 `%PDF-` 魔数；命中 HTML 广告页或验证页一律判失败，不落盘。
- 用 `node:https` 而不是 `fetch`：Sci-Hub 的 PDF CDN（`sci.bban.top`）对 `fetch()` 会 abort/超时，`node:https` 正常返回 PDF。代理支持也建在它上面：给 `client.get()` 装一个自己实现 `createConnection` 的 `Agent`，先 `CONNECT` 再（HTTPS 时）`tls.connect`；`AbortSignal` 交给原生请求，不会逐次累积监听器。
- 只依赖 `node:` 内置模块（`node:https` / `node:http` / `node:fs/promises` / `node:path`），无第三方依赖。
- `Config` 是自写的 Standard Schema 实现：本包不在 profile 的 node_modules 树里，`import '@deepseek-ai/schemastery'` 会直接 `ERR_MODULE_NOT_FOUND`，所以手写一份保持零依赖。
- 输出目录通过 `workingDirectory` 服务解析，取不到时退到该服务的默认目录。
- 文件名：默认按引用元数据（作者 / 年份 / 标题）套 `fileNameTemplate` 生成人类可读名，缺元数据则回退到旧的 DOI 名；详见「文件名：人类可读的统一命名」。

## 安装

### 从插件市场（已收录，最省事）

打开 DSH 的 **Plugins → Plugin Market**（dsh 0.2.1+ 是 Plugins 页里紧邻 Installed 的 "Plugin Market" 标签；旧版在 Settings → Plugin Market），搜索 `dsh-scihub`，一键安装。

### 命令行（现在即可）

```bash
# npm 包（推荐）
dsh plugin --profile web add dsh-scihub

# GitHub Release 预构建 tarball
dsh plugin --profile web add https://github.com/stallenlu/dsh-scihub/releases/download/v0.5.2/dsh-scihub-0.5.2.tgz

# 整仓源码
dsh plugin --profile web add github:stallenlu/dsh-scihub
```

把 `web` 换成自己的 profile 名即可。三种来源任选其一，目录本身也是按「npm → tarball → 源码」这个优先级解析的。

### 用 plugin_manager 安装（官方 npm 版本）

在 DSH 会话里也可以直接用 `plugin_manager` 把官方 npm 版本装进当前 profile：

```bash
plugin_manager install_bundle target=dsh-scihub@0.5.2
```

把 `0.5.2` 换成想安装的版本号即可。这与 `dsh plugin --profile <profile> add dsh-scihub` 等价，来源是 npm registry 上已发布的正式包，不依赖任何本地目录。npm 包自带 `cordis.patch.yml`（含 `- insert:` 行），安装后会自动注入 profile 的层栈，**无需**手工在 profile 的 `cordis.patch.yml` 里添加 `- insert:` 块。

> 不要用 `link:<本地目录>` 或 `target=<本目录绝对路径>` 之类的本地源码装法：本地目录一旦被移动或删除，DSH 重启后会报「包不可用 / `dsh: cannot resolve profile bundle "dsh-scihub"`」。指定官方版本号 `dsh-scihub@<version>` 才能一劳永逸。

> 运行时行为：改动插件的 `lib/host.mjs` 后**需要重启 DSH**（profile 里的插件模块按「一次加载」的模块代缓存，不是改文件即刻生效）；**但改 `lib/mirrors.json` / `lib/libgen-mirrors.json` 不需要重启** —— 它们是每次调用重新读的运行时数据。

## 发布新版本

1. 改 `package.json` 的 `version`，`npm publish --access public`。已发布包的 `repository` 必须指回本仓库，目录才能把 npm 包与条目关联起来（npm 账号与 GitHub 账号不同名属正常）。
2. 打 tag、建 Release、上传 `npm pack` 产物：

   ```bash
   git tag v<version> && git push origin main --tags
   npm pack                                    # 产出 dsh-scihub-<version>.tgz
   gh release create v<version> dsh-scihub-<version>.tgz --title "v<version>" --notes "..."
   ```

3. 更新目录条目 `data/plugins/stallenlu__dsh-scihub.yml` 的 `tarball:` 字段，指向**钉 tag** 的地址 `.../releases/download/v<version>/dsh-scihub-<version>.tgz`。不要用 `latest/download/` —— 文件名按字面取，带版本号会在下一个 release 变成 404。

> 目录里的 `npm:` 字段是自动采集的，手写会被拒；`tarball:` 才是可选的手写字段。npm 包与 Release tarball 二选一即可让市场装到。

## 自测

```bash
node test-naming.mjs                         # 离线、确定性：命名模板 / 元数据回退 / 清洗
node test-integration.mjs                    # 离线：Sci-Hub 全流程 / 命名各分支 / 并发原子写
node test-libgen.mjs                         # 离线：LibGen 解析 / 检索 / 下载 / 扩展名 / 去重
node test-proxy.mjs                          # 离线：代理解析 / CONNECT 隧道 / 重定向 / 信号不泄漏
node test-optimizations.mjs                  # 离线：并发保序 / 死镜像跳过 / 截断与验证墙识别
node test-smoke.mjs                          # 默认 10.1038/nature12373（需联网）
node test-smoke.mjs 10.1103/PhysRevLett.116.061102
```

`test-naming.mjs` 完全离线，只测引用元数据解析、命名模板、文件名清洗与旧名回退，适合 CI。`test-integration.mjs` 用本地假 Sci-Hub 镜像离线覆盖工具注册、命名各分支、并发原子写与 AbortSignal 不泄漏；`test-libgen.mjs` 用本地假 LibGen 镜像离线覆盖结果表解析、检索状态、按 MD5 下载、扩展名保真、Referer、HTML/截断拒绝与去重；`test-proxy.mjs` 用本地假 CONNECT 代理离线覆盖 `resolveProxyUrl` 优先级、`NO_PROXY` 豁免、隧道内 GET / Referer / UA、重定向二次建隧道、代理拒绝、`config.proxy` 接线与 AbortSignal 不累积。`test-optimizations.mjs` 用可编程的本地假镜像离线覆盖批量有界并发且保序、死镜像按 worker 数去重、通用 Cloudflare 文案判 `challenge`，并直接单测 `truncationReason()`。`test-smoke.mjs` 是一条需要联网的最小端到端检查，覆盖五种输入、五种非法输入，以及批量模式：

- `doi`（doi.org 链接，须归一化成裸 DOI）
- `url` 自带 DOI
- `url` 是直连 `.pdf`
- `url` 是文章页，DOI 只在 `citation_doi` meta 里（本地起 HTTP 服务模拟，离线确定性）
- `.pdf` 链接却返回 HTML → 必须报 `error`，不能算下载成功
- 批量：3 条 DOI（2 真实 + 1 不存在）→ `partial`，`counts` 与逐条 `results` 正确
- 批量：空列表 → 入口拒绝
- 两参数同时给 / 都不给 / 非法 DOI / `ftp://` / 非 URL → 全部在入口拒绝
