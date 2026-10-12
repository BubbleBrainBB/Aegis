# Claude Design UI 对齐记录

日期：2026-10-12。实现位置：`src/ui/components/design/`。当前对齐的是 Claude 的内嵌 Design 编辑器；Aegis 的应用外壳和现有设计存储继续使用本项目实现。

## 参考与证据

- Claude 桌面版本：2.31226.1；已捕获的内嵌帧：`/_f/1791789166-8d82/`。
- 分析报告：`/Users/chengshengdeng/Documents/Codex/2026-10-11/an-z/outputs/claude-design-visual-ui-analysis.md`。
- 原始 CSS SHA-256：`704e9497fc103f67b296d5318b472d356aeda386b6ec24e94fed6daceb367ba0`。
- 原始 JS SHA-256：`1980f4c9bad2d948cebb13614aa73632edf715858e6bbb8cf12a788da2bdbd7b`。
- REA 控件分析父证据：`ev_1d405442ddf3a8a6c3d8b59c63dbc859ec7614335ab0f50cc187ae7fd9248dda`。
- 本次通过 REA 再次定位 Tooltip 资源，资产视图证据：`ev_1b36c87bbd102b0e674da57596f9182fe51e59d3f1331ac0850635e20cd9b08e`；文件哈希 `de29296072159042a02ba1bdf37f73fa2caa4e09028e21ca55c2197cfeed77f1`，解析完整。

REA 静态关系不证明运行时等价。独立工作区 Tooltip 的默认 400ms/7px 间距和内嵌 CDS 的 300ms/4px 属于不同控件体系，本实现采用内嵌 CDS 密度与时序。独立模块依赖未全部纳入分析，不能从这些证据声称完整重建。

## 本次改动

- 编辑器颜色全部取自 Aegis 主题：画布和标题栏用 `--app-chrome-bg`（与标签栏连成一片），面板与浮动工具栏用 `--bg-primary`，弹层用 `--popover-bg`，选区用 `--accent`；画布保留很淡的点阵。深色和自定义主题随之变化，不再写死参考配色。
- 标题与下拉箭头是一个控件：单击打开设计菜单，双击原地改名（Enter 保存、Esc 取消），菜单首项也有 Rename。
- 紧凑控件以 24px 高、16px 图标、6px 圆角、13/19px 字体为基准。按压仅缩放背景 paint 层；Tooltip 使用延迟、实测避让与 portal。
- Properties 默认宽度 312px、关闭；可调整 285–560px，并根据容器宽度限制。图层区集成进 Properties/Code，默认 168px，可调整 72–480px，双击恢复。
- 保留 Components、Comments 和 History 的真实功能入口。Size 包含尺寸与 Position，Layout、Appearance、Effects 独立分组；字段改用细边框和统一焦点样式。
- Code 使用共享图层树，保留当前元素自身 CSS 与继承来源，避免重复显示两棵树。
- 缩放菜单加入 25/50/75/100/150/200%、Fit artboards、Layout guides、真实 Undo/Redo 状态；键盘步长 1.25，支持 ⌘/Ctrl+0。
- 菜单支持方向键、Home/End、Escape 焦点恢复，隔离画布快捷键。属性选项、画板操作和导出使用 portal，避免被滚动容器裁切。
- 浮动选择工具栏按实际尺寸限制在画布边缘。Play 使用现有独立预览状态；原 Implement 入口收进 Export 的 Hand off to project。

## 验证

在源码开发版 Aegis（Electron，`127.0.0.1:10087`，1616×1169）中，通过 CUA 检查：

- 打开 312px Properties；图层选择关联到画布与字段；图层分隔条双击回到 168px。
- 属性下拉方向键移动焦点，Escape 返回 Position 按钮，未提交属性修改。
- 切换 Code 保持所选图层，并显示 `From body` 的继承属性。
- 鼠标选择 50%；菜单内方向键和 Return 选择 75%，未误触发画板预览；Fit artboards 恢复全画板视图。
- Play 进入预览后返回，保留 50% 缩放；预览未写回总览相机。
- 画板在左边缘时，选择工具栏和 More 菜单完整可见。
- 缩放菜单显示 Layout guides 和禁用的 Undo/Redo；导出菜单保留 PDF/HTML/PNG 和 Hand off，未执行导出或交付。

检查通过：`git diff --check`、TypeScript、图标导入规范、主题变量检查、Vite production build，以及 7 组非 UI Design 测试（layers/history/comment-prompt/diff/tools/draft/tokens）。构建仍有大 chunk 与 KaTeX 混合导入警告。未运行会在 CUA 外驱动 UI 的 Electron 自动化脚本。

截图与构建日志位于 `output/design-claude-parity/`：

- `before.png`
- `after-properties.png`
- `code.png`
- `zoom-menu.png`
- `board-menu.png`
- `export-menu.png`
- `preview.png`
- `build.log`

## 补齐剩余本地编辑能力（2026-10-12）

本轮使用同一份已捕获 Claude app.js，按 REA skill 分开研究 Pages、Annotations、Tweaks/Code；未把另一构建的 ProjectsPage 当作当前产品证据。

| 区域 | REA 与源码证据 | Aegis 实现 |
| --- | --- | --- |
| Pages | `ev_4445e23bc01ed36efe7f34289e1a63452f223a9cb770803ca2bf2ff4dadf7bc3`，4/4片段解析成功；默认页、上限40页、120字符重命名、至少保留1页 | 新建/切换/重命名/删除；按页显示画板、图层、标注；独立相机；原子版本与撤销 |
| Annotations | `ev_104e56a1ba94c57757b76a8cf39e304b2fab102dff4c1b6282f26877baa3704b`，3文件解析成功；JSON annotations、line endpoints、pen keepTool | Note、Draw、矩形、椭圆、线、箭头；缩放坐标下创建/移动/调整大小/删除，便签文字与颜色，Fill/Stroke/线宽，线/箭头双端点编辑与45°吸附，Fit包含标注 |
| Tweaks/Code | `ev_e222a9e3bb3a447d75c4865adb9d314e066b5b41339a7afd6f84c96bd2a69861`语义分析内存受限；补充当前源码UCe@2144000、registry/propsMeta/setProp/save defaults | Code可写真实inline CSS，matched/inherited只读；Tweaks声明式绑定真实文本/CSS，预览/Reset/Save及revision/lock保护 |
| 预览/导出 | `ev_4ea748b2ae8ffa80ed22300c727eeb6e51246f2a1b28ce51d1bcf6e2ff8a1ad4`独立工作区，覆盖受节点上限限制 | Arrow/PageUp/PageDown保护输入/修饰键；导出当前页/全部页、PNG1×/2×、preparing/saved/canceled状态 |

研究细节在 `/Users/chengshengdeng/Documents/Codex/2026-10-11/an-z/work/claude-core/` 下的 `remaining-pages-workspace-findings.md`、`remaining-tweaks-code-findings.md`、`marks-implementation-findings.md`，以及对应 evidence JSON/精确源码scope。REA的局部解析成功不等于整包语义覆盖。

### 存储与兼容

- SQLite迁移v4。新增可选pages/marks/board.pageId，旧文档和不合法页关联回退第一页面。画板HTML与评论继续走现有存储。
- canvas操作以document revision做CAS，和删除画板一并事务提交；64项操作上限容纳32画板+页更新，现有32画板上限不变。
- scoped restore只恢复pages/marks及目标boardIds，不覆盖无关Agent HTML。历史记录canvasChanged包含页关联变化，冲突时拒绝覆盖。
- Undo追踪自身已知版本，连续undo不把自己的restore误判为Agent修改；失败不弹掉记录，其他窗口未知版本仍有冲突保护。
- 当前pageId写入Agent focus与design_update schema；design_guide扩展页/标注保留规则和声明式Tweaks用法，继续复用Styles/模板/项目规范。
- 当前页HTML导出过滤画板、标注和评论，保留全部页导出选项。PDF/PNG仍是画板导出，画布外标注保存在HTML bundle的canvas.json。
- Aegis独有的底部Agent dock、Styles、1×方向数、Comments、Components、History、草稿与会话关系保留。

### 本轮实机验收

测试在新建的 `Design UI QA` 中进行，未编辑已有 `AI 播客 App` 内容。fixture通过repository限定唯一QA设计和空白board建立，无Agent消息发送。

已观察：

- 新建页同时落地空白画板，重命名能连续输入；切页后其他页画板、图层和标注隐藏。
- 中文Note创建后自动输入、双击再编辑、Cmd+Return提交；矩形和椭圆拖拽创建，Draw提交后保持模式。
- 重新加载后页/便签/矩形保留；仅有标注的空页不再显示画板空态。
- Tweaks真实标题预览、Reset恢复、Save持久化并同步图层树。加入120ms预览节流与随HTML更新的iframe nonce，复测连续输入预览正常。
- Code对选中h1提交color/font-size/margin，matched CSS更新。
- 页删除确认显示当前页画板/标注数量，删除后切回相邻页；菜单Undo恢复被删页的画板数量。快捷键连续撤销已在解锁后补验，见下。
- 完整画布下底部Agent输入条、Styles和方向数均可见；左右工具栏图标同一中心线。

截图：`output/design-claude-parity/pages-marks-tweaks.png`、`code-editable.png`；纯测试日志 `extended-unit-tests.log`、`unit-tests.log`。测试覆盖元数据校验、几何方向/端点交叉/退化线/样式白名单、旧文档、迁移、原子回滚、并发冲突、无关Agent内容保留、页导出隔离、CSS危险值/锁和Tweaks目标约束。

### 解锁后的补充验收与修复

运行环境为同一源码开发版，窗口截图1963×1235，QA设计独立于原有5画板播客设计。

- 箭头描边Blue→Orange、线宽2→8；连续两次⌘Z分别回退为2px与Blue，连续两次⇧⌘Z恢复Orange/8px。
- 键盘Shift+Down调整箭头末端，保存的points保留变化。
- 实测发现端点拖动的pointerup可能落到viewport，未沿标注DOM冒泡，造成只预览、不提交。CanvasMarks增加仅在当前手势有效时工作的window capture move/up/cancel处理，保留Escape/blur取消。
- 修复后末端从约(1367,365)拖到(1520,480)保存成功；起点越过末端至(1620,560)，箭头保持指向原末端。两次⌘Z恢复初始几何，两次⇧⌘Z恢复交叉几何。
- 重新拖拽创建第二支箭头成功。最终HTML导出中第一支箭头points由右下指向左上，第二支为左上到右下，确认几何不是临时预览。
- HTML当前页导出：`qa-current-page.zip`仅含Interaction QA、1个画板和该时刻4个标注；全页导出`qa-all-pages-final.zip`含2页/2画板/5标注。canvas.json与boards条目核对一致。
- 保存对话框绑定发起IPC的BrowserWindow，避免原来的独立窗口被主窗口遮挡；实测系统sheet保存与取消均返回正确状态，取消后编辑恢复。
- 修正HTML范围文案和PNG倍率文案。实机导出`qa-board-1x.png`为880×640，`qa-board-2x.png`为1760×1280，与原画板及所选倍率一致。
- 底部Agent dock、Styles、方向数始终保留；本轮没有向Agent发送测试请求。

截图：`arrow-styles-endpoint.png`、`arrow-crossing-redo.png`、`final-persisted-canvas.png`（刷新后两支箭头和Agent dock仍在）；导出文件均位于`output/design-claude-parity/`。临时事件诊断已移除。PDF保存、45°吸附及所有形状的每个样式组合本轮未逐一实机复测，相关几何与校验有纯测试覆盖。

### 等价边界

这是一套基于证据的Aegis本地实现，不能称整个Claude Design已1:1重建。Claude的任意JavaScript/React组件运行时、__dcRegistry/__dcSetProps、云分享与托管部署没有移植；Aegis保留原有无生成脚本的隔离静态HTML。Tweaks采用显式data-aegis-tweaks协议，无元数据时显示空态，不伪造可用控件。高级旋转、图片裁剪/导入、Claude项目云端生命周期和未获得当前构建证据的功能也不能宣称对齐。

系统字体回退、所有窗口尺寸与深色主题尚未逐像素验收；Tooltip时序、减弱动效和触屏密度未逐帧测量。解锁后已补完导出保存/取消、连续撤销/重做、端点编辑的开发版实机验收；这不代表所有交互和主题逐像素等价。

最终非UI检查：19项纯测试（含现有脚本文件测试）、Electron repository测试、TypeScript、图标与主题变量规范、Electron编译、Vite生产构建通过。Vite仍有原有大chunk/KaTeX混合导入警告。后补的端点与箭头描边/线宽控件已完成下列实机检查。

补充修复后的`npm run build`（含TypeScript/Electron编译）、图标规范、主题变量与diff检查通过；用本仓库esbuild打包后重跑marks/pages/undo三项回归通过，日志`final-regression-tests.log`。首次尝试tsx测试入口时本仓库未安装tsx，已改用现有esbuild，未新增依赖。

修改未提交、未打包安装或发布；运行画面来自源码开发版。

## 工具入口位置修正（2026-10-12）

针对截图里标题栏右侧拥挤的 Page / + Board / History / Export，再次通过 REA 和当前 Claude 实机核对布局。

- 当前 Claude app.js SHA-256：`1980f4c9bad2d948cebb13614aa73632edf715858e6bbb8cf12a788da2bdbd7b`。从字符区间3601440–3602746提取 toolbar JSX，保留在研究目录 `toolbar-placement-scope/`（带manifest）。REA parent Evidence：`ev_54f7e4a646304d2dafcefd0e72b8fb7da516b8936d1e20ec136cf9527d7d1496`；summary：`ev_cabb51029a406721c34a59e26df62c1cf1fa33260bbe3b14a5cdc4c5e574f656`。1个JS文件解析成功，292个AST节点，28项语义未知；这是局部表达式证据，不是完整组件实现恢复。
- JSX的leading插槽对应Pages，工具行之后的extrasEnd为Play，trailing为Properties/Zoom；Claude当前运行的artifact外层控件与此一致。画板内的Aegis mockup内容不作为Claude编辑器控件证据。
- Pages移到左上浮动工具栏首位，菜单左对齐并保持240px宽；右上只保留Play、Properties、Zoom。新建画板保留Frame绘制工具；直接创建默认画板仍可通过标题菜单的New artboard使用。
- History、Styles和整份设计导出合并到标题旁Design actions菜单。这是保留Aegis能力的布局适配，不声称Claude存在相同菜单内容。原先常驻标题栏的按钮行由此取代。Fit继续由Zoom菜单和既有快捷键访问。
- 修复工具栏Pages触发器受通用grid样式影响而换行，以及Pages/Design actions菜单图标与文字不同排的问题。页面确认弹窗改为portal，避免继承画布工具栏布局和被画布裁切。
- 底部Agent dock、方向数、Styles及Comments保留。没有修改用户的AI播客设计内容。

实机验收为源码开发版Electron，1963×1235：Pages单行菜单、Rename打开后Escape取消并恢复Pages焦点；标题菜单History打开/关闭；HTML导出打开原生保存sheet并取消，显示canceled；Frame工具进入绘制模式，Escape回到Select。会话内Design面板从934px缩到499px时右侧工具组下移一行，无工具栏重叠，随后恢复原宽度与完整Design界面。该时刻用户AI播客设计已有6个画板。

截图：`output/design-claude-parity/toolbar-placement-final.png`、`pages-placement-menu.png`、`design-actions-menu.png`、`toolbar-placement-narrow.png`。TypeScript、图标规范、主题变量检查、Vite生产构建及`git diff --check`通过；构建日志`toolbar-build.log`。构建仍有已有的大chunk与KaTeX混合导入警告。本次为入口与布局修改，未重跑全部历史编辑测试；未打包安装或发布。

## 评论可见性与已解决线程（2026-10-12）

### Claude 对照证据

- CUA实机观察了Claude Design的artifact外层Comment按钮与More comment options：未展开列表时显示Show all comments，列表展开后显示Hide comments；点击Hide后All comments面板消失。Comment切到Done commenting，再点一次退出放置模式。Filter comments包含This page / All pages / Show resolved。只操作可见性，没有发送或修改Claude评论。
- 评论Chrome由宿主提供，不能只从画布app.js判断。恢复Claude本地Chromium缓存中的静态JS，按响应content-encoding解压zstd，验证缓存stream CRC并记录SHA。最新缓存header模块为`c547ae5e3-CB424AuW.js`（24580 bytes）；REA parent：`ev_d682967e7ab37783e5e72c61f4c130d9f8c748d9d09d1fe7fb6f1eaa205d26ea`，1个JS解析成功，6658 AST节点，1245语义未知。
- 缓存宿主`frame-shell-chrome-FaCZXS_f.js`中，Yh菜单随Fe切换Show/Hide并调用Ip；Ip(false)走Fp关闭drawer，Af/Mf单独控制评论模式并关闭card/draft。精确提取7个声明，REA parent：`ev_24b6acf605126069a7c61167ff248a6d1ac66619394eab4b963bdabd52f704cc`，1个JS解析成功，329 AST节点，64语义未知。宿主片段未绑定当前运行模块URL，只作为缓存静态参考，由上述实机交互核对；不把缓存mtime视为当前加载版本证明。
- 研究资产在`work/claude-core/comments-current/manifest.json`、`comments-rea-scope/`和`comments-visibility-scope/`，后者manifest记录原始字符区间与SHA。隐藏列表、退出评论模式、解决评论是不同操作，不会因Hide写入resolved状态。

### Aegis修复

- 标题栏增加Comment / Done及More comment options组合控件，显示未解决数量。移除DesignPanel左工具栏重复入口，保留C快捷键、选中元素的Comment操作和独立DesignCanvas的兼容入口。
- Show all comments恢复标记并打开列表；Hide统一关闭评论列表、活动线程和标记并退出放置模式。Done、画布Esc与⇧C复用对应处理。隐藏仅修改查看状态，不删除或解决评论；这是Aegis中清空评论覆盖层的适配，不能把它等同于Claude宿主的每个内部状态转换。
- 原实现的隐藏例外会保留activeCommentId对应pin，导致当前线程仍显示；现已移除。关闭Comments面板也能完整收起，Properties自身的开关行为保持。
- Show resolved可以查看已解决评论，Reopen恢复open状态；活动的已解决线程也有可定位pin。线程按id挂载，避免切换评论时沿用上一条的回复输入状态。
- 打开线程时清空过时的layerTarget，修复resolve/reopen触发文档刷新后，旧图层请求把Comments切回Properties的问题。标题与列表数量按全设计未解决评论统计，避免跨页和活动已解决pin影响计数。

### 验收

在源码开发版的独立Design UI QA画板上新建一条不提及Agent的本地评论：保存→Hide→Show all→重新打开→Resolve→Show resolved→打开已解决线程→Reopen，全流程实机通过。额外验证Done提示条、⇧C双向切换、Esc退出；Hide后AX中线程、pin、列表与放置模式均消失，Show恢复原内容。Resolve/Reopen修复后Comments面板保持选中，未解决数量0/1同步。未向Agent发送测试请求，未修改用户播客画板。

截图：`output/design-claude-parity/comment-hide-menu.png`、`comments-hidden.png`、`comments-resolved.png`。更新现有`design-comment-mode-electron.cjs`回归用例以覆盖新入口、隐藏不改数据、解决与重开保持面板；该脚本通过语法检查，本轮未运行其非CUA UI驱动，交互验收由CUA完成。TypeScript、图标/主题检查、Vite生产构建、diff检查通过；生产构建日志`comments-build.log`，仍有已有的chunk/KaTeX警告。底部Aegent输入条与Aegis其他功能保留，未提交或发布本轮改动。

## 2026-10-12 — Comment edits without rebuilding the visible board

**Cause confirmed in source:** `boardsWithDrafts` replaced an existing board's complete HTML with each partial `design_update/content` argument. `BoardFrame` derived its nonce and `srcDoc` from HTML/contentRevision, so each chunk navigated the affected iframe. Unchanged boards had stable sources; this was not evidence that every board was regenerated.

**REA comparison:** exact AST scopes and source hashes are retained in `work/claude-core/comment-update-scope/manifest.json` in the investigation workspace. REA parent `ev_b490adda5d3777d8259b19b34dfeb392bacd47f28b3643e5f072039f9844ff9c`, summary `ev_5c162ec2a7090141d668e578a12c50b9b98fec052816b292b98b2e1685c159dd` (11 parsed JS scopes, 4938 AST nodes, 1032 semantic unknowns). Cached `desktop-auth-wait-juSiDdvX.js` SHA `73ef994d5fa5c73d4c3cf281facf135bf38bbac3cb6ae0e7450529555584581a`, range 1085828–1093777, defines `dc_html_str_replace`: replace against the baseline template, emit `dc-update` for that component, restore baseline on interrupted edits, and persist final source. Canvas SHA `1980f4c9bad2d948cebb13614aa73632edf715858e6bbb8cf12a788da2bdbd7b`, range 2937696–2938477, guards adoption on the live frame and unsaved local edits, then calls pushLive or emits a template update. These are static cache observations, not proof that every Claude edit uses this route or that no Claude interaction can reload a frame.

**Implemented:**
- Existing boards retain committed content while replacement arguments stream, including completed arguments that have not yet succeeded. Newly added boards still stream.
- Canvas iframes retain their source/nonce. Committed HTML is reconciled inside the frame by stable layer IDs; text, attributes, CSS, insertions, deletion and reorder are supported. Unchanged DOM, form state, scroll, focus and input selection survive. The inspector's stylesheet cache resets and canvas measurements refresh after acknowledgement. A broken bridge can recover with a full sandboxed reload; explicit Reload and separate static preview remain reload paths.
- HTML sanitization is shared by storage and frame input. Generated scripts/active content cannot enter the patch path. The existing opaque-origin sandbox, parent/source/nonce checks and CSP remain in force.
- `design_update` now supports `patch{boardId,expectedRevision,find,replace}`. Exact unique nonempty matches are required; missing/ambiguous targets and stale revisions reject the entire transaction. Idempotency, sanitation, history and comment linkage use the existing repository path. Comment prompts ask for this operation and preserve unrelated markup and layer IDs.

**Validation:** typecheck, Electron transpile, icon/theme checks, Vite build and diff whitespace check passed. Draft/comment prompt/history/layers/tools/diff tests passed. Repository tests passed, including unique patch, unrelated-board preservation, retry idempotency, stale revision, missing/ambiguous match, atomic rollback and script sanitation. `scripts/tests/design-live-update.html` was opened through CUA against the running Vite server and reported ALL CHECKS PASSED: actual BoardFrame updates/undo/rapid revert caused zero iframe load events and kept original srcDoc; detached/isolated DOM checks cover identity, CSS/reorder/deletion/tag change, input state, scroll/focus/selection and rejection of a wrong nonce. A deliberately broken test bridge recovered only its own frame.

**Actual Aegis UI:** on the independent Design UI QA board, changed Heading from “Saved from Tweaks” to “Local comment update QA”, saved, reopened the existing QA comment, hid comments and used Cmd-Z to restore the original heading. Board zoom remained 73%; comment anchor remained usable. No test Agent messages were sent and original AI podcast content was not changed. Evidence: `output/design-claude-parity/comment-local-update-app.png` and `comment-local-update-regression.png`.

**Runtime verification:** renderer changes were hot-loaded and verified. The backend `patch` implementation was tested in a fresh isolated Electron repository process and compiled. CUA denied Terminal access during automatic restart preparation, then the user restarted the dev instance. Process inspection confirmed the new main process started at 08:17:16, after backend compilation at 08:17:15; the QA saved title/comment and original AI podcast page were verified in the app afterward. A live Agent turn using the new patch tool was not sent or claimed as tested. Aegis-specific canvas/Agent controls were retained.

## 2026-10-12 — White button labels disappear during inline editing

User recording: `CleanShot 2026-10-12 at 08.42.09.mp4` (10.57 s). At roughly 2–3 s and 7–8 s, entering text edit on the purple “生成播客” CTA removes its entire colored surface; editing the dark “BubbleBrain” text at roughly 4–5 s appears normal. This is an inline-editor presentation defect, not a failed icon click or a board regeneration.

Root cause: the `aegis-design-mask` handler set `visibility:hidden` on the whole selected layer. `InlineTextEditor` copied the white font color, but intentionally had a transparent background. This removed the button background and placed white text over the light board. The original editor also lacked flex/grid alignment and border insets, shifting text vertically in fixed-height CTAs.

Fix: the trusted frame now masks glyph fill/stroke, text shadow and decoration via a temporary `data-aegis-masked` attribute. It leaves background, gradient, border (including currentColor), shadow, geometry and authored inline styles alone. Inspection supplies typography/layout details to the editor. The editor reproduces flex/grid alignment, native-button centering, transparent border insets, font style, text fill/stroke and text decoration without repainting the button surface. Removing the marker restores the original glyphs.

Regression page: `scripts/tests/design-text-edit.html`, using production `designFrameHtml` and `InlineTextEditor`. Verified through CUA: purple CTA, plain paragraph, native button and gradient grid badge at 0.6 and 1.0 zoom; background/border remain, only glyphs are masked, original inline styles stay byte-identical, text positions stay within 1.5 CSS pixels, color is retained and leaving edit removes the temporary marker. All 40 assertions passed. No user project content was edited by these fixtures. Extracted recording contact sheets are under `output/design-icon-video/`.

Desktop acceptance: after the user unlocked the Mac, verified the running Aegis development app on the original AI podcast design at 62% zoom. Selected Primary CTA and entered Edit text: the purple surface and centered white “生成播客” remained visible. Esc exited editing normally. Repeated entry/exit on the dark “BubbleBrain” label as the recording's comparison; text remained visible and aligned. No text was changed or Agent request sent. Closed the inspector and cleared selection afterward. Evidence: `output/design-icon-video/native-cta-edit.png` and `native-text-edit.png`. Typecheck, Electron transpile, Vite build, layers/draft tests and diff whitespace checks passed.

## 2026-10-12 — Contextual selection toolbar

The user approved removing non-reference toolbar actions. Replaced the selected-element Layers/name/Edit text/Duplicate/Quick edit/Comment strip with capability-specific controls. Removed its Quick edit input, state/handlers and unused CSS; retained the backend API and unrelated Agent/Styles functionality. Layer duplication remains in Properties. Board-level controls are unchanged.

Reference: exact `fEt`, `Tdn`, `cCt` functions from captured Claude bundle SHA `1980f4c9bad2d948cebb13614aa73632edf715858e6bbb8cf12a788da2bdbd7b`, retained in the investigation workspace under `work/claude-core/selection-toolbar-audit/`. REA parent `ev_15b60239e39ba308a76949c3a96f8c805d48d87460900797d72a376f2183406b`; 3 fragments parsed, 4811 AST nodes, 865 semantic unknowns. This establishes conditional text/surface/image/vector strips and icon actions, not full runtime or pixel equivalence.

Implemented:
- Text: font family/size/weight/line height/letter spacing, color, bold/italic/underline, alignment. Existing strike-through survives toggling underline.
- Decorated text/buttons: typography and text color plus fill, border and corner radius. Containers show surface controls. Images show object-fit and radius. SVG shapes show fill/stroke/width; line selections omit fill.
- Edit text, Comment and Properties are compact icon actions with accessible names. No `p` label, constant Duplicate, or Quick edit entry. Controls remain stable while saves are pending.
- Changes use the existing board revision, ancestor lock, CSS validation, saved history and undo path. Form popovers escape the scrollable toolbar; Enter or outside blur commits, Escape discards an uncommitted field. Unsupported link/list structure edits and image replacement/cropping are not advertised as implemented controls.

Validation: `design-selection-tools.html` reports 26 checks passed, covering six selection types, obsolete actions, lock/stale revision/invalid CSS/missing-node rejection, stable IDs, and preservation of nested/unrelated content. CUA browser interactions verified bold, underline without losing strike-through, font size, Escape cancellation, outside-click commit, fill and image-fit persistence, and undo. In the actual running Aegis development app, the independent Design UI QA heading accepted Italic/Underline; Cmd-Z and Cmd-Shift-Z correctly toggled saved Underline state, finally restored. Original podcast content was only selected, not edited: BubbleBrain shows text controls, Primary CTA shows text/surface controls, Properties opens the actual inspector. The earlier native CTA text-edit fix remains intact.

Evidence: `output/design-icon-video/selection-text-native.png`, `selection-button-native.png`, `selection-regression.png`. Typecheck, Vite build, layers tests, icon policy, theme variables and diff checks passed. No commit, package or publication performed. Aegis bottom Agent input and other explicit retained functions remain intact.
