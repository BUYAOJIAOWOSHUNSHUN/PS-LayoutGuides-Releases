# Photoshop UXP 接口笔记

这份文件记录开发过程中实测／查证过的接口行为和坑，避免以后重复踩。
每条都注明依据，标注「待真机验证」的表示只在逻辑层验证过。

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

## 2. 参考线（Guide）不能单独设色？—— DOM 不行，Action Manager 可以（待真机终验）

`src/guide-service.js`、`src/photoshop-host.js`

**UXP DOM API 结论（v1.9.6 前的依据，仍然成立）：**
- `Guide` 对象只有这些成员：`coordinate`、`direction`、`docId`、`id`、`parent`、`typename`、`delete()`。
- 创建方法是 `Guides.add(direction, coordinate)`，只接收方向和坐标。
- **DOM 层没有任何颜色字段。**

**v1.9.7 起的补充结论（来自「新建参考线」对话框能选颜色的反向推理）：**
- 既然 PS 自带的「新建参考线」对话框能随线选颜色，说明**底层数据模型支持单条参考线带色**，
  只是 DOM API 没暴露 —— 走 batchPlay（Action Manager）建线即可带上 RGB 颜色。
- 实现（photoshop-host.addColoredGuide）：batchPlay `_obj:"make"` + `new:{_obj:"guide",
  position, orientation, color:{_obj:"RGBColor", red, grain, blue}}`；
  建完按「方向+坐标+新 ID」在 `doc.guides` 里认领归属；不支持时自动退回普通建线并提示。
- **待真机终验**：颜色键（color → RGBColor{red/grain/blue}）是按 AM 规范推测的，
  真机上若颜色未生效（线是默认色），需要换键名再试（候选：`"Clr "` charID 形式）。

依据：PS「新建参考线」对话框自带颜色选项（用户截图）+ Action Manager 建线事件；真机终验待补。

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
3. `index.html` 里标题后面的 `#headerVersion`（页脚那个 `#versionText` 已删，避免显示两遍）
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
