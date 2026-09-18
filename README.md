# 品牌版式标准规范 PS 插件

品牌版式标准规范是一款 Adobe Photoshop 面板插件，按品牌标准一键生成**版心线、出血线与 LOGO 高度线**，让不同尺寸、不同分辨率的画布始终套用同一套版式比例。

本仓库是插件的公开下载页，同时也是它的在线更新源。

## 下载

当前版本 **v1.9.22** · 需要 Photoshop 27.0.0（2026）及以上

- [**下载免安装版 ZIP（推荐）**](https://github.com/BUYAOJIAOWOSHUNSHUN/PS-LayoutGuides-Releases/raw/main/.download/PS-LayoutGuides-v1.9.22-portable.zip)
  —— 解压后把整个文件夹放进 Photoshop 的 `Plug-ins` 目录，重启即可，不用安装。
- [下载安装包 .ccx](https://github.com/BUYAOJIAOWOSHUNSHUN/PS-LayoutGuides-Releases/raw/main/.download/PS-LayoutGuides-v1.9.22.ccx)
  —— 双击由 Creative Cloud 安装，可覆盖升级旧版。
- [查看全部历史版本](https://github.com/BUYAOJIAOWOSHUNSHUN/PS-LayoutGuides-Releases/tags)

> .ccx 未签名，需要先在 Photoshop 里打开「首选项 → 增效工具 → 启用开发人员模式」才装得上。
> 图省事的话直接用免安装版。

## 安装

### 免安装版（推荐）

1. 下载 ZIP 并解压，得到一个文件夹。
2. 把整个文件夹拷进 Photoshop 的 `Plug-ins` 目录，例如
   `C:\Program Files\Adobe\Adobe Photoshop 2026\Plug-ins\`
3. 重启 Photoshop，在「增效工具」菜单里打开面板。

### .ccx 安装包

先打开「首选项 → 增效工具 → 启用开发人员模式」，再双击 .ccx。

## 在线更新

面板底部点「检查更新」→ 有新版会出现「下载并安装更新」→ 第一次需要选一次插件所在文件夹
（之后会记住）→ **完全退出并重启 Photoshop**，新版本才生效，只关面板不算。

插件如果装在 `C:\Program Files` 下，该目录默认不可写，自动更新会失败并退回「打开发布页」
按钮。两种解法，任选一种：

- 给插件文件夹单独授权（管理员执行一次，之后一直有效）：
  ```
  icacls "C:\Program Files\Adobe\Adobe Photoshop 2026\Plug-ins\品牌版式标准规范PS插件-v1.9.22" /grant "%USERNAME%:(OI)(CI)M" /T
  ```
- 或者把插件挪到用户级目录：`%APPDATA%\Adobe\UXP\Plugins\External\`

## 目录结构

- `manifest.json` —— 插件清单。**面板的「检查更新」是从这里的 `version` 读远端版本号的**，
  所以每次发新版必须改这个值。
- `index.html` / `styles.css` —— 面板界面
- `bootstrap.js` —— 入口
- `src/` —— 逻辑模块
- `assets/` —— 图标资源（PNG，更新时按二进制写入）
- `docs/` —— 接口笔记
- `.download/` —— 上面下载区用的安装包。**故意用 `.` 开头**：插件的更新逻辑会跳过以 `.`
  开头的路径，否则一键更新时会把这几十 KB 的包也写进插件目录。

## 发新版要做什么

1. 改 `manifest.json` 里的 `version`（例如 `1.8.2` → `1.8.3`）。
2. 同步改 `src/update-config.js` 里的 `VERSION`，两处必须一致。
3. 用打包脚本生成 .ccx 与免安装 ZIP，传进 `.download/`，文件名里的版本号要一起改。
4. 把本文件「下载」区的版本号与上面两条链接改成新版本。
5. 提交。

## 注意

- 仓库必须是**公开**的。更新逻辑不带访问令牌，私有仓库读不到（会报 404）。
- 更新是按文件逐个从 raw 地址拉取覆盖，不是下载 zip —— UXP 没有解压能力。

## 版权

©蛋生品牌设计
