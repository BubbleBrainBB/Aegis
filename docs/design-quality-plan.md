# Aegis Design 重做方案：照着 Claude Design 做一个完整的宿主

2026-10-29。参照 [JimLiu/baoyu-design](https://github.com/JimLiu/baoyu-design)，以及它收录的 Claude Design 线上系统提示词（`skills/baoyu-design/references/upstream-system-prompt.md`）。

## 当前状态（2026-10-29）

阶段 1 已实现，并在真实 app 里用 Claude、Codex、Kimi、Grok、Devin、Pi 跑通了同一个 Reader App 需求。与下文原方案的差异：

- **默认仍是画布**。用户实测后决定：设计、mockup、设计稿默认画在画布上；只有明确要「可交互 / 可点击原型、能运行的 App、HTML」时才用 `design_project_create`。
- **新的开放式需求先问一轮**。规则写在两个创建工具的说明和画布指引里（项目提示词要等建项目后才送达，单靠它 agent 会跳过提问）。
- **Claude 会话被告知「本会话不可交互」**：Claude Code 在有未授权 MCP 时会写这句话（本意是 OAuth 无法进行），模型因此不再提问。Aegis 为 Claude 会话关闭 claude.ai 连接器（`ENABLE_CLAUDEAI_MCP_SERVERS=false`，不改用户配置），并在系统提示词里说明会话可交互。
- **提问卡片重做**为一次一题（画布设计「Question card redesign」方案 1a），强调色跟随主题。
- 预览用 iframe 而不是 WebContentsView（原生视图会盖住浮动聊天窗）。
- Google Fonts 离线缓存、提问页、直接编辑等仍属后续阶段。

## 1. 核心判断

Claude Design 的效果来自两部分：

- **提示词**：一份系统提示词，加上 28 个按需读取的技能（Hi-fi design、Interactive prototype、Make a deck……）。
- **宿主**：claude.ai/design 这个产品本身。它提供项目文件系统、预览窗格、画布模式、编辑模式（直接改和拖拽）、评论锚点、Tweaks 工具栏、提问页、后台校验、版本历史、资产面板，以及导出。

baoyu-design 只搬了提示词。它跑在 Claude Code、Cursor 这类通用 Agent 里，没有宿主，所以编辑模式、提问页、Tweaks 工具栏、后台校验都做不了，它自己的文档也写明了这一点（"no harness sends `__activate_edit_mode`"）。即便这样，它已经比我们更像 Claude Design，因为它的产出方式对了：项目里的多文件网页，在浏览器里真跑。

**Aegis 本身就是宿主**，可以两部分都做。做完以后：

- 比 baoyu 更接近 Claude Design，因为宿主功能齐全。
- 有机会超过 Claude Design，因为我们在用户代码库里工作、能用多个模型、能把设计闭环到代码。

我们现在的画布（数据库里的单段 HTML 画板、模板指令、受限逻辑）对应的是 Claude Design 后来新增的 Canvas 制品类型（`canvas.json` + `.dc.html`），不是它出效果的主力模式。**主力模式要新做**，现有画布保留。

## 2. 总体架构

新增一种设计类型 **Design Project**（下文简称"项目"），与现有 Canvas 并列显示在 Design 区。

```
用户仓库/
└── designs/<项目名>/            ← 默认位置，首轮提问时可改
    ├── Reader App.html          ← 交付物（顶层 .html 即资产）
    ├── Reader App v2.html       ← 大改时复制出的新版本
    ├── app.jsx  sidebar.jsx …   ← 拆分的组件文件
    ├── Reader App.brief.md      ← 设计简报（意图、手动改过的值）
    ├── design-canvas.jsx …      ← 拷入的起步组件
    ├── assets/                  ← 图片、字体等
    └── .aegis-design.json       ← 元数据：类型、原始需求、设计系统绑定、资产状态
```

| 部件 | 做法 | 复用 |
|---|---|---|
| 文件读写 | agent 用**自己原生的文件工具**（Read/Write/Edit），所有 provider 都有，不再把整段 HTML 塞进 MCP 调用 | — |
| 本地服务 | 主进程为每个项目起静态 HTTP 服务（`127.0.0.1` 随机端口 + 不可猜路径），只服务该文件夹 | — |
| 预览窗格 | 用 `WebContentsView` 嵌在 Design 区，开着 DevTools、能截图、能拿控制台日志 | `browserManager.ts`、`browser/page-view.ts` |
| 宿主脚本 | 预览页加载时注入宿主脚本，实现编辑模式、选中元素、评论锚点、Tweaks 协议、画布模式 | Design Mode 的 `inspector-script.ts` |
| 依赖库 | 提示词里的 React 18.3.1 / ReactDOM / Babel 7.29.0（固定版本 + integrity）原样保留；主进程拦截这几个固定 URL，返回随 app 打包的文件，离线可用 | `session.webRequest` |
| 字体 | 允许 Google Fonts；主进程缓存，第二次起离线可用 | — |
| 版本 | 每轮 agent 写完、用户保存直接编辑（10 分钟内合并）、删除、恢复时，把文件夹快照进现有的内容寻址存储，形成 v1、v2…… | `design/repository.ts` 的 content 表 |
| 宿主工具 | 只给宿主才能做的事开 MCP 工具（见第 3 节），所有 provider 通过 `aegis-sessions` 拿到 | `design/tools.ts`、`session-http-server.ts` |
| 提示词注入 | 设计会话里，核心提示词走系统提示：Claude 用 system prompt 追加（`runner.ts`），Codex 用 `developerInstructions`；其他 provider 退回为首轮强制调用 `design_guide` | 现有 Codex 设计提示 |
| 校验 | 后台起一个无工具的评审，用截图 + DOM 证据判断，只在有问题时唤醒设计会话 | `verify.ts`、后台任务唤醒机制 |

安全边界：预览页运行在独立 origin，没有 Node 集成、没有 preload 特权；只放行本地服务、被拦截的固定库 URL 和 Google Fonts。现有的沙箱卡死恢复机制继续适用。

## 3. Claude Design 机制逐项对照

对每一项都写明：Claude Design 怎么做 → Aegis 怎么做 → 在哪个阶段做。

### 3.1 工作流与提示词

| Claude Design | Aegis | 阶段 |
|---|---|---|
| 核心系统提示词：身份（"以 HTML 为工具的专家设计师，用户是经理"）、工作流、输出规范、内容规则 | 照着它逐节重写成我们的核心提示词，工具名换成 Aegis 的 | 1 |
| 28 个技能，用 `read_skill_prompt` 按需读 | `design_skill(name)`，返回对应技能文本；技能列表写在核心提示词里 | 1 起分批 |
| 做设计前先读 Hi-fi design；没有品牌时读 Frontend design | 同样写进核心提示词 | 1 |
| 设计简报 `*.brief.md`：决定、手动设置的值、相关文件、落在代码哪里 | 同样做；交接给编码 agent 时一起带上 | 1 |
| 大改时复制成 v2 文件；小改只改被要求的部分 | 同样写进提示词 | 1 |
| 文件超过 1000 行就拆成多个 JSX；每个 Babel 脚本作用域独立，共享组件挂到 `window`；样式对象不能都叫 `styles` | 同样写进提示词 | 1 |
| 紧凑写法：一行一条 CSS 规则，不留空行，因为"每个字节都流给用户" | 同样写进提示词 | 1 |
| 批量并行调用工具；一轮里同一个文件最多读一次 | 同样写进提示词 | 1 |

### 3.2 预览、展示与校验

| Claude Design | Aegis | 阶段 |
|---|---|---|
| `show_to_user(path)`：过程中把文件打开到预览窗格 | `design_show(path)` | 1 |
| `ready_for_verification(path)`：打开文件、返回控制台错误；干净时派后台校验 agent，只在有问题时唤醒 | `design_ready(path)`：同样的语义；`skip_verifier` 用于小改动 | 1 |
| 校验 agent：截图看排版，用 JS 探查；溢出、错位要报告 computed 约束（display、position、box-sizing……）而不是像素症状；检查未解析的 `var()`；结论只有 done 或 needs_work | 同样做；评审可以用和作者不同的模型 | 1 |
| 视觉能力探测：模型看不了图时改用 DOM 证据校验 | 同样做（DeepSeek 等不支持看图的 provider 需要） | 2 |
| `eval_js_user_view`：在用户正在看的页面里执行 JS | `design_eval(js)` | 2 |

### 3.3 和用户的交互

| Claude Design | Aegis | 阶段 |
|---|---|---|
| 提问页 `*.question.html` + `ask_user_page`：宿主提供 question kit，控件有 q-options、q-chips、q-segmented、q-select、q-slider、q-color、q-svg-options、q-text、q-custom、q-user-questions；固定按钮 Send、Decide for me、Ask me follow-up questions；问完结束这一轮，答案作为新消息回来 | 自己实现 question kit（英文 UI）和 `design_ask(path)`，提问页显示在预览窗格；答案作为下一条用户消息回到会话 | 2 |
| 画板提问：`q-board` 里放几个"实时文件窗口"，先开提问再写候选文件，文件写完一个就出现一个 | 同样做（需要 file-window 组件） | 2 |
| 多轮追问：在同一个页面追加 `<q-round>`，不限轮数 | 同样做 | 2 |
| `<mentioned-element>`：用户在预览里评论、直接编辑、拖动某个元素时，消息里带上 React 组件链、DOM 路径、临时 id | 宿主脚本从 React fiber 取组件链，随消息带上（扩展现有的 `designSelection`） | 2 |
| 评论锚点 `data-comment-anchor`；`data-screen-label` 标注每屏或每页 | 同样做；评论面板复用现有组件 | 2 |
| 编辑模式：用户直接改文字、拖动、调样式；样式改动写成 `<style id="__om-edit-overrides">` 里的 `!important` 规则；agent 改样式时要改这条规则 | 同样做：宿主脚本做选中和属性面板，样式写成覆盖规则存回 HTML；纯 HTML 文本直接写回源码；JSX 生成的内容带着 mentioned-element 交给 agent 改 | 3 |
| Tweaks 协议：页面发 `__edit_mode_available`，宿主工具栏出现开关；改动通过 `__edit_mode_set_keys` 回传，宿主改写文件里的 `/*EDITMODE-BEGIN*/…/*EDITMODE-END*/` 默认值，持久化到磁盘 | 同样做 | 2 |
| 画布模式：`<meta name="design_doc_mode" content="canvas">`，宿主提供平移、缩放和灰底，页面里绝对定位放各个方案 | 同样做；React 页面也可以用 design-canvas 起步组件 | 2 |
| 资产面板：交付物列表，状态 needs-review / approved / changes-requested | 项目侧栏列出顶层 `.html` 及其版本，状态存在 `.aegis-design.json` | 1 |
| 版本历史：v1、v2……只追加；agent 不能直接恢复，只能读旧版本重写 | `design_versions` / `design_version(n, paths)`；面板里有 Restore | 1 |

### 3.4 起步组件

`copy_starter_component(kind)` 把组件拷进项目。全部**自己实现**，接口和能力照着做：

| 组件 | 能力 | 阶段 |
|---|---|---|
| design_canvas.jsx | 带分区和画板的平移缩放画布，拖动排序，单个画板全屏查看 | 1 |
| ios_frame.jsx / android_frame.jsx | iOS 26 液态玻璃、Material 3；状态栏、导航栏、列表、键盘 | 1 |
| macos_window.jsx / browser_window.jsx | macOS Tahoe 窗口、带标签的浏览器 | 1 |
| tweaks_panel.jsx | `useTweaks` + 浮动面板 + 各类控件，内置 Tweaks 协议 | 2 |
| image_slot.js | 可拖入、可重新取景的图片槽 | 2 |
| deck_stage.js | 缩放适配、键盘导航、缩略图栏、演讲者备注、逐项出现动画、每页一张打印 | 3 |
| doc_page.js | 流式分页和固定页两种文档模式，自带打印 | 3 |
| animations.jsx | 以时间为输入的动画时间轴，可导出视频 | 4 |
| chart_stage.js | 基于 d3 的图表舞台：尺寸、缩放、提示、空状态、导出 | 4 |
| 社交外壳 | X、Instagram、小红书、微信公众号、抖音等 | 4 |
| file_window.js | 嵌入另一个项目文件的实时窗口（画板提问用） | 2 |

### 3.5 技能

照着 Claude Design 的技能清单逐个写，按阶段分批：

- **阶段 1**：Hi-fi design、Interactive prototype、Frontend design、Wireframe、Mobile prototype、Make a deck、Make a doc、Website & landing page。
- **阶段 2**：Ask the user、Make tweakable、Design feedback。
- **阶段 3**：Save as PDF、Save as standalone HTML、Handoff to coding agent、Export as PPTX（截图版）。
- **阶段 4**：Animated video、Data visualization、Social media content、HTML email、Flier、Create design system、Export as PPTX（可编辑）、Speaker notes、Web research、Maps & geography、3D object、Claude API in prototypes（`window.claude.complete`，由 Aegis 用当前会话的 provider 实现）。

### 3.6 设计系统与导入

| Claude Design | Aegis | 阶段 |
|---|---|---|
| 绑定设计系统后，每次加载生成一份设计系统提示：token 白名单、组件 props 和枚举契约、组件用法；视为强制 | 现有项目 `design-system/` 文件夹作为来源，生成同样的绑定提示 | 3 |
| 从 GitHub 仓库、现成 HTML/CSS、Figma 文件导入 | GitHub 和本地代码库优先（我们本来就在仓库里）；Figma 放到最后 | 4 |

### 3.7 导出

| Claude Design | Aegis | 阶段 |
|---|---|---|
| PDF：按设计尺寸出页面，冻结动画 | 用预览页 `printToPDF` | 3 |
| 独立 HTML：把所有资源内联成一个离线文件 | 同样做 | 3 |
| PPTX 截图版 / 可编辑版 | 截图版先做；可编辑版（DOM 映射成原生文字和形状）后做 | 3 / 4 |
| 交接给 Claude Code | 交接给 Aegis 里的任意编码会话，附简报 | 3 |

## 4. 分阶段计划

### 阶段 1：主力模式跑通（L）

目标是先把"效果"做出来：同一个需求，产出接近 Claude Design。

- Design Project 类型：创建、在 Design 区列出、打开。
- 本地服务、预览窗格、固定库拦截、Google Fonts 缓存。
- 核心提示词和 8 个阶段 1 技能（照着写），按 provider 注入。
- 宿主工具：`design_show`、`design_ready`（含后台校验）、`design_skill`、`design_starter_copy`、`design_versions` / `design_version`。
- 起步组件：design_canvas、iOS、Android、macOS、浏览器外框。
- 资产列表和版本快照。

**验收**：README 里那个 Reader Mac App 提示词，在 Aegis 里用 Claude 和 Codex 各跑一遍，产出一个可点击的三栏原型；和 Claude Design 的截图并排看，不落下风。

### 阶段 2：和用户来回（M–L）

- 提问页（question kit、画板提问、多轮、Decide for me）。
- 选中元素和评论（mentioned-element、评论锚点、screen label）。
- Tweaks 协议和工具栏开关；tweaks_panel、image_slot、file_window 组件。
- 画布模式 meta。
- 视觉能力探测、`design_eval`。

### 阶段 3：直接编辑与交付（L）

- 编辑模式：选中、属性面板、文字原地编辑、拖动排序；样式覆盖写回；JSX 内容交给 agent。
- deck_stage、doc_page。
- 导出：PDF、独立 HTML、PPTX 截图版；交接。
- 设计系统绑定提示。

### 阶段 4：广度（M，可以一直往后排）

剩下的技能和组件、可编辑 PPTX、视频导出、导入、`window.claude`。

### 阶段 5：超过 Claude Design

这些是 Claude Design 的架构做不到、而 Aegis 有底子的：

1. **扎根代码库**：项目就在用户仓库里，提示词里"好的设计来自已有的设计上下文"这条，我们可以自动做到：读项目的 Tailwind 配置、CSS 变量、组件，直接作为设计系统；进一步让原型直接用项目自己的组件渲染。
2. **设计到代码闭环**：选定的设计交给编码会话实现，用内置浏览器打开实现后的页面，和设计稿截图对比，差异再交回去修。Claude Design 止步于交接。
3. **多模型出方向**：几个方向分别交给不同的 agent 并行做，汇总到同一个画布里对比。
4. **跨模型校验**：作者和评审用不同模型。
5. **中文与本地化**：中文排版、中文平台社交外壳。

## 5. 现有画布怎么办

- 保留，不迁移。它适合"在画布上直接摆、直接拖"的静态稿和幻灯片，也已经有完整的编辑 UI。
- 新建设计时由 agent 按需求选类型：可交互原型、多屏 App、需要真实交互的东西用 Project；单屏视觉稿和需要大量手动拖拽微调的用 Canvas。
- 阶段 3 编辑模式做完以后，再评估两者是否合并。

## 6. 要你拍板的几件事

1. **文件放在哪**：默认 `designs/<项目名>/` 放在用户仓库里（agent 原生文件工具只能写项目目录；也方便 git 和交接）。没有项目的聊天放在 app 数据目录。
2. **提示词照着写的程度**：结构、流程、规则全部对齐 Claude Design，措辞用我们自己的；工具名换成 Aegis 的。
3. **设计会话默认模型**：Claude Design 推荐最强模型；是否在 Design 里默认选 Opus（用户可改）。
4. **阶段 1 先只支持 Claude 和 Codex**，其他 provider 走"首轮读指引"的降级方式，阶段 2 再补齐验证。
