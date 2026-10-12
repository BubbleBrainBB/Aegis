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
