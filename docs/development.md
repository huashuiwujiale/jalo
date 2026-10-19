# 开发与验证

Jalo 的产品目标是 macOS。Linux 云环境用于逻辑测试和模拟 Electron 界面回归；它不能代替 macOS 原生行为与安装包验收。开发服务通过 tsx/Vite 直接加载源码，不需要编译或打包应用。

## 1. macOS 日常开发

使用 Node.js 22.14+；仓库 `.nvmrc` 选择 Node 22。

```sh
nvm use 22
npm ci
npm test
npm run test:ui
npm run dev
```

`npm run dev` 使用 `127.0.0.1:5173`，端口已占用时退出。`npm run test:ui` 自动清除 `ELECTRON_RUN_AS_NODE`，使用临时项目、独立数据目录和模拟 IPC，不访问已有任务库或真实模型。测试会打开临时窗口，结束时关闭并清理数据。

macOS 使用 node-pty 自带预编译模块，`prepare-pty.mjs` 只修正辅助程序的执行权限。

## 2. Linux 云端逻辑测试

先准备 Node.js 22.14+、npm、Python 3、make、C++ 编译器和 `/bin/zsh`。这些是依赖与测试要求，不表示 Jalo 提供 Linux 安装包。

```sh
npm ci --ignore-scripts
node node_modules/esbuild/install.js
npm run setup:pty
npm test
```

`--ignore-scripts` 避免安装过程隐式触发原生编译。`npm run setup:pty` 是显式的依赖准备操作：先验证已安装的 node-pty，只有 Linux 缺少可加载模块时才重建该依赖。官方 Node 发行包包含的匹配头文件会直接复用；其他安装方式可使用 node-gyp 支持的 `npm_config_nodedir` 指向匹配头文件。此步骤不编译或打包 Jalo；不要为排查下载问题关闭 TLS 或校验。

受限云环境应将 npm 缓存指向可写目录，并沿用平台提供的代理与 CA 配置；不要将代理认证值写入仓库或日志。安装 Electron 时，其下载器还需启用平台代理，例如设置 `ELECTRON_GET_USE_PROXY=1`，并将继承的 HTTPS 代理用于 `GLOBAL_AGENT_HTTPS_PROXY`。Electron 的可写缓存目录使用 `electron_config_cache`。

## 3. Linux 模拟界面回归

在逻辑依赖之外，还需要 Electron 的 GTK/NSS 等系统运行库、Xvfb 和 xauth。安装 Electron 资产后运行：

```sh
node node_modules/electron/install.js
xvfb-run -a npm run test:ui
```

若环境提供 Chromium 用户命名空间沙箱，但不提供 root 所有的 setuid 辅助程序，可以显式使用：

```sh
xvfb-run -a npm run test:ui -- --disable-setuid-sandbox
```

这保留 Chromium 的命名空间及渲染进程沙箱。如果命令执行器的嵌套隔离禁止创建用户命名空间，应通过平台支持的执行权限流程运行该测试；不要用 `--no-sandbox` 代替。云任务里只做内部请求验证，不创建 localhost 预览链接。

界面回归覆盖 Markdown 与复制/链接失败恢复、富文本文件引用及完整路径序列化、草稿与窗口重开、长历史锚点、滚动与布局调整、任务分页、搜索、重命名和归档。它使用模拟任务，不证明真实模型推理、utilityProcess 或 macOS 系统集成已经通过。

## 4. macOS 原生与真实模型验收

在 Mac 上运行 `npm run dev`，检查真实窗口、文件夹选择、终端交互与命令确认，以及 safeStorage 令牌保存。连接 LM Studio 或 Ollama 并选择支持工具调用的模型后，再按 README 运行 `npm run test:live` 或专项可靠性实测。只使用脚本创建的临时项目；不要拿业务仓库做写入验收。

真实模型验收是独立步骤。模型服务未提供或模型未加载时，报告“未运行”，不要把模拟模型测试或界面测试当作真实模型通过。Apple Silicon 安装包、签名和公证属于单独的 macOS 发布流程，只有用户明确要求时才执行构建或打包。

## 结果记录

每项代码修改完成后先运行相关检查，再单独提交。报告实际执行的测试、失败/跳过/未运行项及平台范围。云环境保存的依赖可以复用；Vite、Xvfb 和 Electron 进程需要在新任务中重新启动。

2026-10-19 的 Linux 云端验证：Node 22.23.3，逻辑测试 211 项通过、0 失败；Electron 模拟界面回归通过；100 次临时文件替换检查未返回旧符号链接。macOS 原生与真实模型验收未在此环境运行。
