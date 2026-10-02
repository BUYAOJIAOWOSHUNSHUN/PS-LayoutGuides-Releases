# Photoshop UXP 接口笔记

这份文件记录开发过程中实测／查证过的接口行为和坑，避免以后重复踩。
文中验证文件路径指向开发时的本地版本归档；验证文件不随公开源码或安装包分发。
每条都注明依据，标注「待真机验证」的表示只在逻辑层验证过。

## v2.1.4：独立保存按钮（2026-10-02）

“打开文件夹”右侧增加“保存”，复用src/document-save.js的saveDocument，调用活动文档原生save()。首次保存由Photoshop显示保存窗口；已有文件沿用原路径，不打开系统文件夹，不经过PSD／TIFF储存为按钮。云文档不套用打开本机文件夹的限制，交由原生保存处理；云文档仅有逻辑检查，未真机验证。

按钮接入统一禁用列表与鼠标／Enter／Space动作。保存开始前同步设置busy，阻止重复点击及其他受保护操作；完成、取消或失败均解除busy并刷新实际保存状态。保存前后检查文档ID，取消或未确认saved=true时不显示保存成功。82项定向检查与main.js语法检查通过，独立审查未发现必要缺陷。

2026-10-02真机入口验收：Photoshop 27.9.1，RGB8临时稿，600×400、100PPI。实际点击新增按钮：首次取消保持saved=false、无路径、红字保留，面板恢复；首次保存PSD后saved=true、路径／名称正确、红字消失；编辑文字后再次点击直接保存原位置，无文件选择或目录授权弹窗。第一次保存历史21，编辑后历史22，第二次保存仍22；智能对象、可编辑文字／分组、隐藏层及选区保持。输出PSD哈希随第二次保存变化，测试稿已关闭。鼠标入口已真机验证；键盘入口、云文档及磁盘错误等仅由逻辑检查覆盖。详情 `验证/host-acceptance.md`。

## v2.1.4：导航器缩略图、视图缩放与红框平移

`imaging.getPixels` 指定 `documentID`、整画布 `sourceBounds`、最多 480×240 的 `targetSize`，读取当前合成结果，不指定单一 `layerID` 或 `historyStateID`。请求 RGB / sRGB / 8 位和 `applyAlpha:true`，只在小尺寸缓冲区中处理。历史状态与嵌套图层可见性用于去重和异步结果核对，不用于锁定历史取像；图层显隐在本机可能不增加历史状态。

Photoshop 可能裁掉透明边缘。返回的 `sourceBounds` 对应 `level` 的缓存坐标，乘以 `2^level` 后才映射回原画布。将小尺寸裁剪结果拼回白底整画布，再由 `createImageDataFromBuffer` 和 `encodeImageData({base64:true})` 生成 JPEG 数据 URI。JPEG 仅用于面板预览。每条成功、失败和过期路径都释放源与生成的 `PhotoshopImageData`。

历史标识、图层可见性、文档 ID、模式或尺寸变化才请求新像素。可见性使用最多 5000 层的有界迭代，集合异常、缺失或超界，以及历史标识不可读时退为 5 秒慢刷新。每次最多一个像素读取；普通读取失败至少隔 5 秒再试；Imaging API 不存在时报告局部错误，不阻止面板启动。构造不触发读取，面板隐藏后不再发起请求。

Imaging 操作在单次 `executeAsModal` 作用域内读取、合成、编码及释放，不调用文档修改命令。`PhotoshopImageData` 是原生代理，按尺寸、RGB / 8 位 / 3 通道及方法校验，兼容 callable 值。原始错误在作用域内保存，再在作用域外处理，避免 Photoshop 包装回调错误后丢失诊断阶段。

视图缩放读取 `Document.zoom` 的百分比。通过 `setPanZoom` 指定文档 ID，`z` 使用百分比除以 100 的比例值，`resize:false`、`animate:false`，在 modal 作用域中执行，再回读真实比例。队列最多一个命令在执行，保留最新值，切换文档或隐藏面板后丢弃过期请求。滑条 `input` 仅预览百分比，`change` 提交视图缩放，轮询不覆盖拖动草稿，也不重复写入控件状态。滑条范围 0.08%–12800% 是本插件配置，未声称为所有 Photoshop 版本的官方上限。

红框以文档 ID 分别读取 `viewInfo.activeView.globalBounds` 和六项 `viewTransform`，每 250ms 检查，最多一批在读取，面板隐藏后停止。Windows 屏幕比例来自 `core.getDisplayConfiguration()` 的 `globalBounds` / `scaleFactor`；Mac 使用逻辑坐标。矩阵将视口局部逻辑坐标映射为画布像素；本机原生边界为含末端像素的范围，所以跨度使用 `right-left+1` 与 `bottom-top+1`。红框裁切到画布，平移使用未裁切中心。读取期间文档 ID、尺寸或倍率变化则丢弃并重读；无法命中屏幕缩放或视图旋转时隐藏红框。

本机 72 / 100 PPI 临时文档校准确认：`setPanZoom.x/y` 虽标为 `pixelsUnit`，实际接收的是视图坐标，不是直接的画布中心像素。非旋转矩阵对角值为 `a,d` 时，目标中心 `cx,cy` 需使用 `x=cx/a,y=cy/d`；PPI 未另行换算。拖动和平移与缩放共享一个 modal 写入队列，保留最新坐标，过期文档或倍率不会被恢复。拖动时先显示目标红框，再回读真实视口；未提交尺寸草稿保持原值。

真机已验证 RGB 8 位透明边缘、CMYK 16 位竖幅、空透明白底、文档切换、同历史状态下显隐刷新、内容编辑 / 历史回退刷新、尺寸草稿保留、缩放按钮 / 点选轨道与红框显示 / 双向拖动。用户补测持续拖动红框及缩放滑块，反馈“正常”。空透明文档返回有效像素 / 空边界时显示白底；null imageData 仍提示无法读取，不把未知值认作成功。模拟测试不能替代其他宿主版本的验证。

视口变换依据本机 Adobe 自带 `Required/UXP/com.adobe.photoshop.inAppMessaging/js/792.js` 内嵌源 `src/utils/location.ts` 的变换方向，以及 `验证/host-output/viewport-pan-calibration.txt` 的原生命令校准。相关公开文档：https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/displayunits 与 https://developer.adobe.com/photoshop/uxp/2022/ps-reference/objects/returnobjects/displayconfiguration 。其他显示配置和 Photoshop 版本仍需各自验证。

依据（2026-09-30 查阅）：
- https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/imaging
- https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/document
- https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/executeasmodal
- https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-spectrum/spectrum-uxp-widgets/user-interface/sp-slider
- 本机 Adobe 内置 `Required/UXP/common.js` 和 `com.adobe.photoshop.adjustments-panel/js/ps.js`；本版临时文档的截图观察与原生视图查询。

---

## v2.1.4：保存归属与完成状态修复

旧 PSD／TIFF 按钮调用临时 duplicate 的副本保存；原文档仍未保存是该实现的实际结果。当前按钮按“文件→储存为”目标保存当前文档：PSD 使用 `saveAs.psd(file, {layers:true}, false)`，TIFF 原生 `save` descriptor 使用 `copy:false`。文件名、路径和 saved 状态由 Photoshop 更新，不手工伪造。JPG／PNG 继续导出，不清除原文档的未保存修改。

`save()`／储存为进入与退出 modal 前后均检查目标文档 ID；操作前及完成后读取新的 `ps.app.activeDocument`。保存完成最多读取26次 actual `saved===true`，间隔200ms，最长约5秒；该等待只读状态，不重复保存。取消在 modal 回调内识别，避免宿主包装异常后丢失取消字段；取消、失败或始终未确认保存完成时不打开目录、不强制隐藏红字。

原生“现在保存”曾出现的真实异常根因尚未确认；新对象重读与延迟等待属于兼容处理，须以真机结果判断。保存相关72项定向检查通过，覆盖路径归属、对象更新、延迟、取消、文档切换与 JPG／PNG 回归；真机记录在本地 `验证/host-acceptance.md`。

本机Photoshop27.9.1已确认首次save、已有PSD再次save、当前文档PSD储存为与CMYK16位TIFF默认保存：saved=true，名称与路径正确，面板红字清除。确认窗、PSD位置选择及TIFF原生选项取消时保持未保存。真实关闭并重开PSD／TIFF后文字、智能对象、分组、隐藏层、尺寸、模式与位深保留。该结果验证这些临时样本，未复现用户原文件上的旧异常。

打开目录沿用`uxp.shell.openPath`和manifest既有空扩展名授权。Adobe要求用户明确同意，可在原生窗口“记住我的选择”；公开接口没有自动批准或静默跳过授权参数。本机同一测试目录第二次打开未再请求权限，其他目录与重新安装后的复用未验证。依据：https://developer.adobe.com/uxp/guides/how-to/recipes/external-process/ 。

依据（2026-10-01）：https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/document 。`saved` 表示最后修改后是否保存；`save()` 保存当前位置，首次保存提示原生窗口；`saveAs` 的 `asCopy` 参数决定保存归属。

---

## v2.1.3：保存状态与原生保存

`Document.saved` 表示最后一次修改后是否保存，不能用它判断文件路径是否存在。`Document.path` 对本地文件为完整路径，对云文档为标识。红字单独刷新，不加入尺寸变化判断，避免保存状态变化冲掉输入草稿。

未保存文档先使用 `dialog.uxpShowModal` 提供“现在保存 / 取消”。只有返回 `save` 才在 `executeAsModal({interactive:true})` 中调用目标文档的 `save()`。首次保存会显示 Photoshop 原生保存窗口；已有路径时按原生保存处理。保存前后核对文档 ID，完成后重新读取保存状态和本地路径，取消或报错不打开目录。

Photoshop 27.9.1 已实测首次保存与原生保存窗口取消、已有路径保存、确认窗取消 / 关闭、编辑后红字出现、保存后红字清除、系统目录打开及实际保存文件。收尾版重启加载后，在 1200×800 RGB 8 位测试文档中输入 900×600 草稿：文档仍为 1200×800，编辑文字和插件内保存、PS 原生 Ctrl+S 保存均未清掉草稿。切换到首次未保存的 600×400 空白文档时显示红字，切回已保存文档时清除；空白文档即使 `saved` 为 true，也因没有本地路径正确显示首次未保存。

依据（2026-09-30 查阅；真机边界见上文）：
- https://developer.adobe.com/photoshop/uxp/ps_reference/classes/document/
- https://developer.adobe.com/uxp/guides/how-to/add-modal-dialogs/
- https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/executeasmodal

---

## 1. 标尺原点是 16.16 定点数

`src/origin.js`

通过 Action Manager 读取 `rulerOriginH` / `rulerOriginV` 时，返回的整数是
**16.16 定点格式**（高 16 位整数、低 16 位小数），需要除以 65536 才是像素。

```js
value / 65536          // 正确
value >> 16            // 错误：会截断小数，负数还会算错
```

依据：Action Manager 的坐标类数值统一使用 16.16 定点。
**待真机验证**：需要在 PS 里把标尺原点拖到非整数位置，确认辅助线落点无偏移。

---

## 2. 参考线独立颜色（v2.0.0）

UXP Guide DOM 没有颜色字段。旧版通过猜测 Clr / color / guidesColor 参数，并在“成功建线、颜色未知”时视为成功；这不能证明颜色已经生效。

2026-09-27 本机 Photoshop 27.9 验证的新路径：

- 单条创建命令为 `make`，`new._obj` 为 `good`，不是 RGBColor 对象。
- `new` 包含整数 `$GdCA: 0`、`$GdCR`、`$GdCG`、`$GdCB`，并包含 direction 对应的 orientation 枚举和 pixelsUnit 的 position。
- 顶层 `guideTarget` 为 `guideTargetCanvas`。不修改全局参考线偏好。
- 原生“新建参考线版面”对话框选洋红后，返回 RGB 255/74/255。新版出血采用该值，普通线采用青色 74/255/255。
- 单线创建的实际返回 `result.new` 包含颜色通道、方向、原生目标文档和参考线索引。正式代码逐项核对返回值，并以创建前后 ID 差集核对 DOM 的文档归属、方向、坐标和数量。
- 通用 `get guide`（ID 或 index）返回位置、方向、归属和 ID，但不含颜色。不能再用“字段缺失但没报错”判断颜色成功。
- 当前 Guide 查询无法检测用户手动改色，因此不使用仅坐标匹配的“已是最新”捷径。重新点创建时重建本会话拥有的参考线，确保应用指定颜色；失败时整次历史事务回滚。

捕获证据在 v2.0.0 版本目录的 `验证/guide-color-capture.json` 与 `验证/guide-color-probe.json`；整合验证结果见同目录的验证说明。颜色是参考线的显示色，不是文档 CMYK 印刷像素。

来源：
- https://developer.adobe.com/photoshop/uxp/2022/ps_reference/classes/guide/
- https://forums.creativeclouddeveloper.com/t/problem-setting-guides-color-with-batchplay/5629/3
- https://community.adobe.com/questions-712/adjust-script-to-add-artboard-guides-instead-of-document-guides-1176637

---
## 2.1 画布扩展颜色与拾色弹窗（v1.9.25）

本节替代 v1.9.9 的旧 canvasSize/颜色回退描述。

src/photoshop-host.js 调用 src/canvas-service.js。由 executeAsModal 提供 context，在一次 suspendHistory/resumeHistory 内执行以下过程：保存原选区与整幅画布为临时 Alpha 通道、DOM resizeCanvas、加载原画布通道并反选、切到背景层和复合通道、执行 fill、恢复选区与活动图层/通道、移除本次临时通道。

fill 采用 ActionJSON 的 fill / fillContents / color / RGBColor（绿色键 grain），dialogOptions 为 silent。检查 batchPlay 返回的 error 描述符，不能只依赖 Promise reject。错误触发 resumeHistory(id, false)；显式回滚失败时不能声称已经恢复。

Photoshop 的 Layers/Channels 集合可能是 Proxy：通过 length 和索引逐项复制，不使用 Array.prototype.slice（真机出现稀疏数组，恢复图层时报 Undefined 错误）。

2026-09-27 在 Photoshop 27.9 中以当前模块运行 20 项真实文档检查，覆盖 RGB/CMYK 的 2000×1500→3000×1500、九锚点奇数差值、横扩纵缩、实际像素、选区保留、单步历史恢复和填色错误回滚，全部通过。原画布 Alpha 的新增像素为未选中区域的假设已在这些场景验证。测试证据位于 v1.9.25 本地版本目录的 验证/canvas-native-report.json；v2.0.0 沿用该画布模块。大型复杂文档、快速蒙版、越界选区等未按普通扩展场景泛化通过。

取色器由原生 UXP dialog.showModal({lockDocumentFocus:true}) 承载；模块还处理宿主返回的 Promise，关闭/取消后释放监听并结束调用。静态 PNG 色相条与透明 SV 遮罩用于避免动态 CSS 渐变在 UXP 上的显示差异。HSB/RGB/HEX 均只修改弹窗草稿，确认才交回 main.js。

参考 Adobe 官方文档：
- https://developer.adobe.com/photoshop/uxp/ps_reference/classes/selection/
- https://developer.adobe.com/photoshop/uxp/ps_reference/media/batchplay/
- https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/executeasmodal

---

## 3. 插件安装目录只读

`src/update-service.js`

UXP 的文件系统沙箱分三块：

| 位置 | 权限 | 说明 |
|---|---|---|
| `plugin://` | **只读** | 插件安装目录 |
| `plugin-data://` | 读写 | 插件数据目录，持久保存，卸载时清除 |
| `plugin-temp://` | 读写 | 临时目录，可能被自动清空 |

manifest 里 `requiredPermissions.localFileSystem` 有三档：

- `plugin`（默认）：只能访问上面三个沙箱位置
- `request`：可以通过文件选择器访问用户指定的文件/文件夹
- `fullAccess`：无限制，但**仍受操作系统限制**，Program Files 这类系统位置普通权限写不进去

结论：**插件无法覆盖自己的安装文件**，所以做不到「点一下自动替换、重启生效」。
当前实现是：下载新文件 → 写入用户选定的插件目录 → 提示重启 Photoshop。
如果插件装在 `C:\Program Files` 下，写入会失败，需要管理员权限或手动覆盖。

依据：Adobe UXP 文件系统沙箱文档 + manifest v5 权限文档。

---

## 4. UXP 支持 fetch，但没有解压能力

`src/update-service.js`

- 网络：UXP 支持 `fetch`、`XMLHttpRequest`、`WebSocket`。
  必须在 manifest 的 `requiredPermissions.network.domains` 里声明域名，否则请求被拦。
- **没有 zip 解压能力**。所以在线更新不走「下载 zip 解压」，改成：
  1. `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1` 列出仓库文件
  2. 逐个从 `raw.githubusercontent.com` 拉取覆盖

版本号不依赖 Release 的 tag，而是直接读仓库里的 `manifest.json`，更可靠。
仓库没有 Release 时自动退回默认分支（`HEAD`）。

---

## 5. 辅助线显示/隐藏用 commandID 3503

`src/photoshop-host.js`

- 读取状态：`batchPlay` 的 `uiInfo` + `getCommandEnabled`，取返回值的 `checked`。
- 切换：`ps.core.performMenuCommand({ commandID: 3503 })`。

3503 对应「视图 > 显示 > 参考线」。
切换后必须回读一次确认状态真的变了，否则视为失败（面板会报错）。

---

## 6. 写文档必须走 executeAsModal + suspendHistory

`src/guide-service.js`

任何修改文档的操作都要包在 `ps.core.executeAsModal()` 里，并且用
`context.hostControl.suspendHistory()` / `resumeHistory()` 包成一步可撤销的操作。

- `resumeHistory(suspension, true)` = 提交
- `resumeHistory(suspension, false)` = 回滚

注意 `resumeHistory` 本身也要放在 try/catch 里：操作被取消时它可能抛错，
此时**把异常继续往外抛**，让 executeAsModal 自动取消仍然挂起的历史记录。

---

## 7. UI 组件的选择

- 只用 `sp-button` 这类 Spectrum 组件，加上普通 `div` / `span` / `img`。
  **输入框不用 `sp-textfield`**，见 7.3。
- **避免原生 `<button>`**，UXP 对它的支持不可靠。
- **避免内联 SVG**，兼容性没保证。图标（眼睛、挂锁、垃圾桶、上下步进箭头）统一预渲染成 PNG，
  JS 只切 `<img>` 的 `src`，绕开 `transform` / `border-radius` 这些支持不稳定的属性。
  步进箭头**也是 PNG**：CSS `border` 拼三角在浏览器里是斜接的，在 UXP 里只剩一条横杠。
- 面板宽度**定死 420px**：`minimumSize.width` 与 `maximumSize.width` 都是 420，
  高度 400~2560 可拉伸，内容靠纵向滚动。
  注意改宽度要同时改 4 处 `manifest.json`（min / max / preferredDocked / preferredFloating），
  以及 `_开发工具/截图.py` 和 `_开发工具/生成界面预览.js` 里的宽度常量。

### 7.1 别指望能改 Spectrum 组件内部的样式

Spectrum 组件在 UXP 里是**黑盒**（Adobe 原话 "a black-box solution that does not allow
you to peek into the details"），组件内部自己画的部分，外面的 CSS 够不着。
已踩到的四个坑，共同点都是**浏览器预览里完全看不出来，只有真机才现原形**：

| 现象 | 结论 |
|---|---|
| `sp-button` 里图标和文字不横排（图标在上、文字在下还被裁） | 图标 + 文字要自己包一层 `.button-inner`（自己的 flex row） |
| CSS `border` 三角在真机只剩一条横杠 | 小箭头一律出 PNG |
| `sp-textfield` 内部底色写死近黑，CSS 变量盖不掉 | 见 7.3，整块自绘 |
| `sp-textfield` 的 `quiet` 变体只去了边框、**没去底色** | 同上，`quiet` 不是这个问题的解 |

所以判断一个 Spectrum 组件的样式能不能改，**不要看浏览器预览，也不要只信文档**，
要么真机试，要么干脆自己包一层 / 自己画。

### 7.2 出血数值框为什么是自绘的（`span` + 键盘事件）

`sp-textfield` 的内部底色是组件自己画的（真机实测 `#1e1e1e`），
`--spectrum-textfield-background-color` 和 `quiet` 变体都盖不掉。
外面套一个浅灰容器就变成「灰框里挖了个黑洞」，所以整块自绘：

- 结构：`span.bleed-value[role=textbox][tabindex=0]` + `.stepper` + `span.bleed-unit`
- **UXP 里除 `sp-textfield` 外没有可用的文本输入控件**，键盘得自己接：
  数字 / 小数点 / 退格 / 回车 / Esc / 上下箭头，全部在 `onBleedKeydown` 里处理。
- **自绘控件没有光标**，所以「追加」语义是错的（显示 `2` 时敲 `3` 会变成 `23`）。
  规则：**本次编辑的第一个按键替换原值**，之后才追加 —— 等价于原生输入框获焦时全选。
- 自绘元素点一下**不会自动获焦**，`click` 里要补一个 `focus()`。
- 焦点态用 `.bleed-value:focus` 自己给底色（`#4d4d4d`）。
- `blur` 提交，但 `commitBleedEdit` 要先判断「是否真的在编辑中」，
  否则每次点步进箭头都会白跑一次提交，和步进结果打架。
- `editing` 状态在 `writeBleedValue` / `onBleedInput` 里都要清掉，
  防止「点箭头 → 再点别处」触发重复提交。

### 7.3 DOM 操作要避开这几个写法

UXP 的 DOM 是自研实现，不是浏览器那套，以下写法**不保证可用**，已全部替换掉：

| 避免 | 改用 |
|---|---|
| `for...of` 遍历 `element.children` | 用下标遍历 `element.childNodes`，筛 `nodeType === 1` |
| `element.innerHTML = ""` | `while (el.firstChild) el.removeChild(el.firstChild)` |
| `Array.from(htmlCollection)` | 同上，手写循环收集 |
| `classList.add/remove` | 直接赋值 `element.className` |
| `document.querySelector` | `document.getElementById` |
| `position: absolute` 做图标叠放 | flex 纵向/横向堆叠 + `align-self` |

依据：UXP 的 DOM 实现与浏览器有差异，`Symbol.iterator`、`innerHTML` 等属于未承诺能力。
这类问题不会在逻辑层测试里暴露，只会在真机上表现为「某块 UI 空白」，
所以宁可写得啰嗦一点。

### 7.4 初始化要分块兜错

`src/main.js` 的 `start()` 里，品牌菜单和出血输入各自包一层 try/catch。
它们依赖图片资源和自绘输入框的键盘绑定，万一在真机上初始化失败，
不至于连累辅助线按钮整体不可用。

**待真机验证（v1.8.3 自绘输入框的根本风险）**：自绘的 `span` 在真机上
**能不能收到 `keydown`**。UXP 里除 `sp-textfield` 外没有可用的文本输入控件，
键盘是自己接的；万一真机不给自绘元素派发键盘事件，用户就只剩上下箭头可用。
真机试的时候**务必点一下数值框敲个数字**。

第二条：`span` 加 `tabindex="0"` 后 `.bleed-value:focus` 的焦点底色在真机上是否生效。
不生效只是「看不出焦点在哪」，不影响功能。

---

## 8. 版本号需要同步的地方

改版本时四处都要改，漏一处就会出现版本显示不一致：

1. `manifest.json` 的 `version`
2. `src/update-config.js` 的 `VERSION`
3. `index.html` 的页脚 `#footerVersion`（启动时也由 `VERSION` 写入）
4. 文件夹名 / 文件名 `品牌版式标准规范PS插件-vX.Y.Z`

**每次发版必须提版本号**：插件是拿远端 manifest 的 `version` 和本地比大小
（`compareVersions(latest, current) > 0`），两边一样就判定「已是最新」，一键更新根本不会触发。

---

## 9. 改图片大小 / 画布大小（v1.8.4）

`src/photoshop-host.js` 的 `resizeImage` / `resizeCanvas`，对应 PS 的
「图像大小」与「画布大小」两个对话框。

```js
// 图片大小：宽高是像素，resolution 是 PPI。BICUBIC 是 PS 的默认重采样方式。
await doc.resizeImage(width, height, resolution, ps.constants.ResampleMethod.BICUBIC);

// 画布大小：宽高是像素，anchor 决定画面往哪个方向扩展/收缩。
await doc.resizeCanvas(width, height, ps.constants.AnchorPosition[anchor]);
```

`AnchorPosition` 的九个取值：`TOPLEFT` / `TOPCENTER` / `TOPRIGHT` /
`MIDDLELEFT` / `MIDDLECENTER` / `MIDDLERIGHT` / `BOTTOMLEFT` / `BOTTOMCENTER` / `BOTTOMRIGHT`。
默认用 `MIDDLECENTER`（中心不动，四边一起变）。

**单位换算**：PS 的 API 只吃像素。界面上画布大小按厘米输入，
转像素是 `Math.round(cm * resolution / 2.54)`；反过来显示是 `px / resolution * 2.54`。

和辅助线一样，两个调用都必须包在 `executeAsModal` 里，见第 6 节。

**真机待验证**（逻辑层只能验证参数算得对，验证不了 PS 认不认）：
1. `resizeImage` / `resizeCanvas` 在 UXP 里是否真的生效；
2. `AnchorPosition` 的枚举名是不是这套（写错会拿到 `undefined`，PS 会抛错）；
3. 改完能不能 Ctrl+Z 整步撤销 —— 取决于 `executeAsModal` 里的 suspend/resume 是否成对。

## 2.2 RGB / CMYK 保留图层（v2.0.0）

使用 Photoshop“图像 → 模式”对应的 `convertMode`，目标 class 为 `RGBColorMode` / `CMYKColorMode`，显式指定 `flatten:false`、`merge:false`、`rasterize:false`。本机 Photoshop 27.9 内置 UXP 的 `doc.changeMode` 仅明确 `flatten:false`；本版改为显式描述符以覆盖不栅格化要求。

转换处于一个可回滚的历史事务中。前后核对图层 ID、顺序、分组关系、类型、文字及位深；若宿主无法保留这些状态则回滚，并报告失败，不通过自动合并或栅格化完成转换。这里不核对像素颜色一致性，颜色转换本来会改变色彩表示。

原生参数参考作者本人在 Adobe Community 给出的脚本：
https://community.adobe.com/questions-712/is-there-a-way-to-get-photoshop-to-stop-asking-to-merge-or-don-t-merge-when-chaging-color-modes-1176437

本机临时文档验证记录见版本根目录“验证/mode-native-report.json”。

原生边界：27.9 的 RGB → CMYK `convertMode` 在包含曲线调整层的样稿中会移除该调整层，即使 `flatten:false` / `rasterize:false`；其他文字、智能对象、分组和空像素层仍保留。`mode-native-diagnosis.json` 保存原始返回与转换后层树。本版严格拒绝缺层结果并回滚，不把参数返回成功当作图层保留成功。
