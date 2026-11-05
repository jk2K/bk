# BK

Git 原生业务知识自动演进 CLI。监听 Git 与网页来源，提出可追溯的业务规则变更，由人工审核后进入正式知识库。

**当前为 0.2 开发预览版**。已打通 Git → Claude Agent SDK → 证据校验 → 隔离 worktree → 本地提案 / Draft PR 的核心链路。完整需求与设计分别见 [PRD](docs/01-PRD.md) 和 [技术设计](docs/02-TECHNICAL-DESIGN.md)；功能边界与验证情况见 [实现状态](docs/IMPLEMENTATION.md)。

## 开发与安装

要求 Node.js 24+、Git；远程审核需要已认证的 `gh`、`glab` 或 Gitea `gt` / `tea`。

```bash
npm ci
npm run build
npm test
npm link
bk --help
```

网页来源另外安装浏览器：

```bash
npx playwright install chromium
```

## 初始化知识仓库

CLI 源码仓库与业务知识仓库分开维护。

```bash
bk init ../business-knowledge
cd ../business-knowledge
git init -b main
git add .
git commit -m "Initialize business knowledge"
```

`bk init` 不覆盖既有文件，并将 `.bk/` 加入 `.gitignore`。所有扫描快照、SQLite、浏览器 Profile 和候选 worktree 均存放在 `.bk/`。

编辑 `bk.yaml`，加入你的来源，例如：

```yaml
sources:
  - id: product-prd
    type: git
    role: requirement
    url: /absolute/path/to/prd-repository
    branch: main
    include: ["**/*.md"]
    exclude: ["**/drafts/**"]
    interval: 30m
    data_classification: public
```

支持 `requirement`、`design`、`implementation`、`test`、`external-policy` 五种证据角色。源码或测试独立提出的规则写入会被降级为冲突报告，不能直接替代批准的业务意图。修改来源 URL、分支或范围时请使用新来源 ID；当前不提供自动检查点迁移。

## 执行

```bash
# 扫描无需模型权限，不调用 Agent
bk scan
bk status --json

# 配置企业批准的模型认证；可使用 SDK 支持的云平台环境认证
export ANTHROPIC_API_KEY=your-approved-key
bk doctor

# 先预览，再生成隔离的本地待审提案
bk sync --dry-run
bk sync --local
bk proposals

# 内置常驻调度，Ctrl+C / SIGTERM 优雅停止
bk watch
```

`--json`、`-C <知识仓库路径>` 为全局选项，可放在命令前后。失败返回非零退出码。`doctor` 检查环境认证变量是否存在，**不代表模型已实际验证可用**。

默认来源分类是 `internal`，默认禁止向模型传输内部数据。确认已获准传输后，在 `agent` 中明确配置 `allow_internal_data: true`；`restricted` 来源始终阻断。凭据仅放在环境或平台 CLI 凭据系统，不写入 YAML。内置脱敏只是辅助，不能代替公司的数据准入判断。

模型失败后，事件会保存并退避重试；达到上限或被策略阻断后，修复原因再手动重排：

```bash
bk history --limit 20
bk retry <change-id>
bk analyze
```

`sync --dry-run` 允许本地扫描、缓存和模型调用，但不创建提案分支、不提交、不 Push、不创建远程 PR，也不会消费掉待分析事件。

## 网页与登录态

```yaml
sources:
  - id: internal-wiki
    type: web
    role: requirement
    url: https://wiki.example.com/business/
    interval: 6h
    browser:
      profile: internal-wiki
      headless: true
      login_url: https://wiki.example.com/login
      auth_selector: "[data-authenticated-user]"
    crawl:
      allowed_hosts: ["wiki.example.com"]
      include: ["/business/**"]
      exclude: ["/business/admin/**"]
      max_depth: 2
      max_pages: 30
      wait_for: main
```

```bash
bk browser login internal-wiki
# 手动完成 SSO/MFA 后关闭浏览器窗口
bk browser status internal-wiki
bk source test internal-wiki
```

不同 Profile 独占使用；自动抓取限制主机、导航路径与请求方法，拦截写请求，保留可见正文、链接和 Markdown 表格。需要资源 CDN 时显式加入 `allowed_hosts`。建议配置 `auth_selector`，否则无法可靠区分所有自定义 SSO 登录页。登录失效的来源在 watch 中暂停；成功登录后重新启用。

### 受控智能浏览与 Recipe

需要展开、切换标签或站内搜索时，在 `agent` 中设置 `allow_interactive_browser: true`，并为对应来源设置 `browser.interactive: true`。原生 `<details><summary>` 可直接展开；其他可操作控件必须在 `browser.readonly_selectors` 中逐项列出。

```yaml
agent:
  allow_interactive_browser: true

# sources 中对应网页的 browser 配置
# browser:
#   profile: internal-wiki
#   interactive: true
#   readonly_selectors: ["#requirements-tab", "input[type=search]"]
```

可用工具为正文快照、允许控件的点击/搜索、滚动和遮盖表单字段的视口截图。拒绝表单提交按钮、任意文件读取、任意 JavaScript、Shell 以及超出来源范围的导航。点击导致文档 URL 变化会阻断任务；多页抓取由普通爬取器管理，暂不支持 Agent 任意跳页。

`bk scan` 始终不调用模型。`bk sync` 才会按配置进行智能展开，随后提取可见正文并形成不可变快照；`bk analyze` 消费这些已有快照，不重新访问页面。隐藏内容和表单字段不会被当成可见正文。标记为需要交互的来源如果没有可用的正式 Recipe，`scan` 会明确要求运行 `sync`，不会把未展开内容误记为已删除。

成功操作记录为结构化 Recipe，先在新导航上实际回放并比较正文，再保存至 `.bk/recipe-drafts/<source-id>/`。人工检查后，将文件放入知识仓库的 `recipes/` 并通过普通 Git 审核提交，再设置 `browser.recipe: recipes/wiki.json`。只执行目标正式分支已提交的 Recipe，不读取未提交修改，不执行任意脚本。URL、来源范围或控件白名单变化会使旧 Recipe 失效；失效后可降级重新探索。

### 图片与规则关联

```yaml
compiler:
  image:
    enabled: true
    verify_semantics: true
    max_per_page: 4
    max_per_run: 10
    max_bytes: 2000000
```

开启后，PNG/JPEG/WebP 图片通过浏览器认证上下文读取，校验主机、重定向、类型、大小和文件签名，在 `.bk/assets/` 按字节 Hash 缓存。同一 URL 换图也会生成新来源版本。超过限制时保留原检查点并明确报错。

分析阶段先分类，再将关系图转成节点/连线中间结构和经过解析器校验的 Mermaid；统计图输出可读数据表，UI/照片输出说明。`verify_semantics` 开启第二轮视觉核对；推断结果按图片 Hash、模型和提示词/Schema 版本缓存。原图不进知识 Git。

图片解读明确标为未经人工核实的派生证据。包含视觉证据的文档所提出的写入会转为待确认报告；不会直接把模型看图的结果当成已批准规则。

文本分析按“来源与定位反查 → 中英文关键词匹配 → 相邻规则”选择上下文，再通过三个只读 MCP 工具分段读取固定快照与相关规则。模型无权读取任意本地路径。关联规则的数据分类也会检查，避免公开来源任务将内部知识意外发送出去。

## 人工审核

默认 `review.mode: local`：提案、报告和补丁位于 `.bk/proposals/<id>/`，正式工作树不变。审核后可检查并合并本地 `bk/knowledge/<id>` 分支。规则正文采用 `bk:statement` 标记，后续更新只替换受管理正文并更新元数据，保留标记外的人工段落。

远程审核示例：

```yaml
review:
  mode: pull-request
  provider: github # github | gitlab | gitea；显式指定自建平台
  cli: gh          # gh | glab | gt | tea
  auto_merge: false
  proposal_branch_prefix: bk/knowledge/
```

为知识仓库配置 `origin` 并完成平台 CLI 登录。BK 创建独立分支和待审核 PR/MR，按分支查询以避免远程成功、本地失败后重复创建。不会自动合并。重跑会查询审核状态，只有确认合并提交包含在目标分支时才记录发布。读取远程最新正式规则不会检出或覆盖用户工作树。

目前按来源变更事件隔离提案；多个事件连续更新同一规则时可能产生需要人工处理的分支冲突，还没有实现跨事件的同规则 PR 合并更新。

## 校验与测试

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
bk validate
```

测试使用本地真实 Git 仓库验证新增、修改、重命名、删除、强推、持久检查点、模型失败重试、干运行、提案去重及用户工作区隔离。平台 CLI 使用契约模拟测试；不将其等同于真实平台联调。Claude SDK 禁用任意内置工具与项目设置，只注册来源、规则和受限浏览工具。浏览器集成测试会启动真实 Chromium；推理测试使用可替换 SDK 测试适配器，尚未验证真实企业模型。

CI 会安装 Chromium 并要求浏览器测试实际执行。本机已有 Chromium 时可用 `BK_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium npm test`；容器确有需要时显式设置 `BK_CHROMIUM_NO_SANDBOX=1`。分析缓存会随模型、正式知识 Commit 或提示词/Schema 版本失效。
