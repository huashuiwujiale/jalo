# Jalo 本机 DMG 打包说明

本文适用于在 Apple Silicon（M 系列）Mac 上打包并安装自己使用的 Jalo。当前版本为 `0.2.1`，使用本地临时签名（ad-hoc），未使用 Apple Developer ID 签名或公证。

## 1. 准备环境

- macOS，Apple Silicon / ARM64；当前命令不生成 Intel 版。
- Node.js 22.14 或更高版本，推荐使用项目 `.nvmrc` 指定的 Node.js 22。
- 已安装项目依赖；首次安装依赖或下载 Electron 时需要网络。

在终端进入项目，启用 Node.js 22：

```sh
cd /Volumes/MacintoshExtention/workspace/Codex/jalo
nvm use
node --version
```

如果终端没有加载 nvm，可以在佳乐当前这台 Mac 使用已安装的 Node.js：

```sh
export PATH="/Users/jiale/.nvm/versions/node/v22.19.0/bin:$PATH"
```

新下载的项目或依赖发生变化时执行 `npm ci`。它会根据 `package-lock.json` 重建 `node_modules`；依赖已准备好时可跳过。

## 2. 版本与检查

重新发布一个新版本前，同时更新 `package.json`、`package-lock.json` 的根版本和 `packages[""].version`。例如下次从 `0.2.1` 升到 `0.2.2`，可以执行：

```sh
npm version patch --no-git-tag-version
```

此命令更新版本文件，不创建 Git 提交或标签。仅重做同一版本安装包时无需再次升版本，但同名 DMG 会被覆盖；需保留时请先另存旧安装包。

按需运行逻辑测试：

```sh
npm test
```

## 3. 生成 DMG

```sh
npm run dist:mac
```

这条命令会编译界面和主进程／任务引擎，再运行 electron-builder 生成 DMG，因此只在明确需要安装包时执行。

当前脚本固定 `--mac dmg --arm64 --publish never`，不会上传 GitHub 或发布安装包。配置位于 `electron-builder.json`：应用标识为 `com.jiale.jalo`，使用临时签名，DMG 包含 Jalo 应用和指向 `/Applications` 的快捷方式。

以 `0.2.1` 为例，产物位于：

```text
release/
├── Jalo-0.2.1-mac-arm64.dmg       # 用于安装
├── Jalo-0.2.1-mac-arm64.dmg.blockmap
└── mac-arm64/Jalo.app            # 打包生成的应用
```

安装只需要 `.dmg`。`dist/` 和 `release/` 已被 Git 忽略，提交代码不会包含安装包。应用包含 Electron 运行时，安装使用不要求本机有 Node.js；模型推理仍需要 LM Studio。

## 4. 检查产物

以下命令检查镜像完整性及应用签名；下次升级版本后请替换 DMG 文件名：

```sh
hdiutil verify release/Jalo-0.2.1-mac-arm64.dmg
codesign --verify --deep --strict --verbose=2 release/mac-arm64/Jalo.app
```

签名检查通过只表示本地签名完整，不等于 Apple 公证或业务功能验收。建议安装后核对版本、打开项目，检查文件树、草稿恢复和模型连接，再开始实际任务。

## 5. 安装或更新

1. 完成或停止正在运行、等待确认及排队中的任务。
2. 在 Jalo 的“模型与设置 → 应用与诊断 → 打开数据目录”查看实际数据位置。退出 Jalo，将整个目录复制一份备份，包含数据库、`backups/`、`recovery/` 和 `ui-session.json`（如存在）。如果仍有数据库的 `-wal`、`-shm` 文件，也须一并复制，不能仅复制主数据库或删除 WAL。
3. 双击 `release/Jalo-0.2.1-mac-arm64.dmg`，把 Jalo 拖入 Applications；已有安装时选择替换。
4. 推出镜像，从“应用程序”打开 Jalo，在“应用与诊断”确认版本为 `0.2.1` 且为安装版。
5. 核对项目、历史任务和草稿，再连接 LM Studio。

替换应用不会主动删除数据目录。开发版与安装版共用实际数据目录，更新时应退出两者。当前没有自动更新；每次修改源码后，需要重新打包、替换应用才能在安装版中生效。

## 6. 常见问题

- **Node.js 版本太旧**：先 `nvm use`，再用 `node --version` 确认；避免系统自带的旧版 Node.js。
- **缺少依赖或打包器**：在项目根目录执行 `npm ci` 后重新打包。下载失败时检查网络或代理。
- **DMG 创建失败／磁盘空间不足**：保留终端完整错误，检查磁盘空间，关闭先前打开的安装镜像后重试。
- **系统提示无法验证开发者**：这是临时签名包；确认是本机生成的文件后，按 macOS 提示在“系统设置 → 隐私与安全性”中允许打开。不要关闭全局安全设置。
- **提示应用损坏**：先用上面的镜像与签名检查命令确认产物完整；检查失败时重新打包，不直接忽略错误。
- **安装后仍显示旧版本**：退出全部 Jalo 进程，重新替换 Applications 中的应用，从 Applications 启动；不要继续运行旧 DMG 或其他目录中的副本。
- **模型不能连接**：安装包不内置模型。先启动 LM Studio 的本地服务，再检查地址、访问令牌和模型设置。

此流程用于个人本机安装。面向他人分发时，再单独配置 Developer ID 签名、公证和发布流程。
