# dsh-scihub

DeepSeek Harness 插件：按 **DOI 或 URL** 从 Sci-Hub 镜像抓取论文 PDF，保存到当前会话工作区。

> Sci-Hub 是影子图书馆，其可用性与合法性因司法辖区而异。插件只如实报告它实际拿到了什么，不会把失败包装成成功。

## 分发与收录

本插件同时通过三种渠道分发，任意一种都能装进 DSH：

| 渠道 | 状态 / 地址 |
|---|---|
| **npm 包** | `dsh-scihub@0.4.0` 已发布 → https://www.npmjs.com/package/dsh-scihub |
| **GitHub Release 预构建包** | `v0.4.0` 已附 `dsh-scihub-0.4.0.tgz` → https://github.com/stallenlu/dsh-scihub/releases/tag/v0.4.0 |
| **dshmarket 插件市场** | 已向官方目录提交收录 PR [#12966](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12966)；合并后站点重新生成 `plugins.json`，dshmarket 通常一天内即可搜索并一键安装 |

目录会优先使用已发布的 npm 包，其次作者提供的 Release 预构建 tarball，最后回退到整仓 GitHub 源码。仓库已加 `dsh-plugin` topic，`package.json` 声明 `dsh.bundle` 且 `repository` 指回本仓库，根目录 `cordis.patch.yml` 含 `- insert:` —— 这些是目录投稿的硬性要求。

## 提供的能力

注册两个模型工具：

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

## 镜像列表：一键更新

镜像存活是今天的快照，不是永久事实。列表是**数据**，不在代码里：

- 运行时真源是 `lib/mirrors.json`：`{"updatedAt": "...", "mirrors": [...]}`。
- 每次调用都**重新读**这个文件 → 改完立即生效，**不需要重启 DSH**。

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
```

优先级：`config.mirrors` > `config.mirrorFile` > `lib/mirrors.json`。

## 实现要点

- 上一次成功的镜像会被提到最前面，所以列表里哪天死一个，只会在第一次请求时白跑一趟，之后不再付这个代价。
- `sci-hub.jp`（最初指定的域名）已确认是停放站：任何路径都返回 610 字节纯广告壳，**不在列表里**。
- 其余候选的死法：`.se .ink .io .work .tech .3800808.xyz .nsm.plus` 无 DNS；`.st .box .mksa.top` 是 DDoS-Guard 403；`.wf` 503；`.ru` 是 Cloudflare「are you a robot」；`.tf` 404、`.cat` 501、`.pub .help .li .tw` 超时/重置；`.ist` 同为停放壳。
- 文章页的 PDF 链接来自 `<embed id="pdf" src="...">`；页面「save」按钮里那份 JSON 转义的同一链接（`\\\\/`）也会被解析。
- 下载后校验 `%PDF-` 魔数；命中 HTML 广告页或验证页一律判失败，不落盘。
- 用 `node:https` 而不是 `fetch`：Sci-Hub 的 PDF CDN（`sci.bban.top`）对 `fetch()` 会 abort/超时，`node:https` 正常返回 PDF。
- 只依赖 `node:` 内置模块（`node:https` / `node:http` / `node:fs/promises` / `node:path`），无第三方依赖。
- `Config` 是自写的 Standard Schema 实现：本包不在 profile 的 node_modules 树里，`import '@deepseek-ai/schemastery'` 会直接 `ERR_MODULE_NOT_FOUND`，所以手写一份保持零依赖。
- 输出目录通过 `workingDirectory` 服务解析，取不到时退到该服务的默认目录。
- 文件名：走 DOI 时用 `<doi 压平>.pdf`，直连时用 URL 最后一段。

## 安装

### 从插件市场（收录合并后，最省事）

打开 DSH 的 **Plugins → Plugin Market**（dsh 0.2.1+ 是 Plugins 页里紧邻 Installed 的 "Plugin Market" 标签；旧版在 Settings → Plugin Market），搜索 `dsh-scihub`，一键安装。

### 命令行（现在即可）

```bash
# npm 包（推荐）
dsh plugin --profile web add dsh-scihub

# GitHub Release 预构建 tarball
dsh plugin --profile web add https://github.com/stallenlu/dsh-scihub/releases/download/v0.4.0/dsh-scihub-0.4.0.tgz

# 整仓源码
dsh plugin --profile web add github:stallenlu/dsh-scihub
```

把 `web` 换成自己的 profile 名即可。三种来源任选其一，目录本身也是按「npm → tarball → 源码」这个优先级解析的。

### 用 plugin_manager 安装（官方 npm 版本）

在 DSH 会话里也可以直接用 `plugin_manager` 把官方 npm 版本装进当前 profile：

```bash
plugin_manager install_bundle target=dsh-scihub@0.4.0
```

把 `0.4.0` 换成想安装的版本号即可。这与 `dsh plugin --profile <profile> add dsh-scihub` 等价，来源是 npm registry 上已发布的正式包，不依赖任何本地目录。npm 包自带 `cordis.patch.yml`（含 `- insert:` 行），安装后会自动注入 profile 的层栈，**无需**手工在 profile 的 `cordis.patch.yml` 里添加 `- insert:` 块。

> 不要用 `link:<本地目录>` 或 `target=<本目录绝对路径>` 之类的本地源码装法：本地目录一旦被移动或删除，DSH 重启后会报「包不可用 / `dsh: cannot resolve profile bundle "dsh-scihub"`」。指定官方版本号 `dsh-scihub@<version>` 才能一劳永逸。

> 运行时行为：改动插件的 `lib/host.mjs` 后**需要重启 DSH**（profile 里的插件模块按「一次加载」的模块代缓存，不是改文件即刻生效）；**但改 `lib/mirrors.json` 不需要重启** —— 它是每次调用重新读的运行时数据。

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
node test-smoke.mjs                          # 默认 10.1038/nature12373
node test-smoke.mjs 10.1103/PhysRevLett.116.061102
```

一条最小端到端检查，覆盖五种输入、五种非法输入，以及批量模式：

- `doi`（doi.org 链接，须归一化成裸 DOI）
- `url` 自带 DOI
- `url` 是直连 `.pdf`
- `url` 是文章页，DOI 只在 `citation_doi` meta 里（本地起 HTTP 服务模拟，离线确定性）
- `.pdf` 链接却返回 HTML → 必须报 `error`，不能算下载成功
- 批量：3 条 DOI（2 真实 + 1 不存在）→ `partial`，`counts` 与逐条 `results` 正确
- 批量：空列表 → 入口拒绝
- 两参数同时给 / 都不给 / 非法 DOI / `ftp://` / 非 URL → 全部在入口拒绝
