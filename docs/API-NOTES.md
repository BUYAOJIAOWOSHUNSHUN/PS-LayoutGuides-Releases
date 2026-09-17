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

## 2. 参考线（Guide）不能单独设色

`src/guide-service.js`

- `Guide` 对象只有这些成员：`coordinate`、`direction`、`docId`、`id`、`parent`、`typename`、`delete()`。
- 创建方法是 `Guides.add(direction, coordinate)`，只接收方向和坐标。
- **没有任何颜色字段。**

参考线颜色属于 Photoshop 的全局首选项（首选项 > 参考线、网格和切片），改一次所有参考线一起变。

结论：靠颜色区分「版心线 / LOGO 线 / 出血线」在原生辅助线机制下做不到。
当前方案是**靠位置区分**（出血线在画布外，版心线在画布内）。
如果一定要彩色分组，只能改用图层线条（会进图层栈，导出前需要隐藏）。

依据：Adobe UXP Photoshop API 参考 —— Guides / Guide 类文档。

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

- 只用 `sp-button`、`sp-textfield` 这类 Spectrum 组件，加上普通 `div` / `span` / `img`。
- **避免原生 `<button>`**，UXP 对它的支持不可靠。
- **避免内联 SVG**，兼容性没保证。有轮廓感的图标（眼睛、挂锁、垃圾桶）统一预渲染成 PNG，
  JS 只切 `<img>` 的 `src`，绕开 `transform` / `border-radius` 这些支持不稳定的属性。
  只有极简形状（上下步进三角箭头）还用 `div` + `border` 拼。
- 面板宽度按 380px 设计（`preferredDockedSize`），最小 320×480。

### 7.1 DOM 操作要避开这几个写法

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

### 7.2 初始化要分块兜错

`src/main.js` 的 `start()` 里，品牌菜单和出血输入各自包一层 try/catch。
它们依赖图片资源和输入框组件，万一在真机上初始化失败，
不至于连累辅助线按钮整体不可用。

**待真机验证**：把单位文字放进 `sp-textfield` 内部需要覆盖原生边框，
当前用 `border: none` + `--spectrum-textfield-border-color: transparent` 尝试覆盖。
UXP 的输入框是封装组件，可能盖不干净，出现「框里套框」。
盖不住的话备选方案：单位贴框外右侧，或整个输入框自绘。

---

## 8. 版本号需要同步的地方

改版本时三处都要改，漏一处就会出现版本显示不一致：

1. `manifest.json` 的 `version`
2. `src/update-config.js` 的 `VERSION`
3. 文件夹名 / 文件名 `品牌版式标准规范PS插件-vX.Y.Z`
