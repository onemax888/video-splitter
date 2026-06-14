# 🎬 Video Clipping 视频切片工具

高效的视频切片工具，基于 Tauri + React 构建的跨平台桌面应用。

![Video Clipping Screenshot](docs/screenshot.png)

---

## ✨ 功能特点

- 🎯 **按时长切分** - 将长视频按指定时长自动切分成多个片段
- ⚡ **无损切分** - 使用 FFmpeg 流复制，无需重新编码，速度极快
- 🖱️ **拖拽上传** - 支持拖拽视频文件或点击选择
- ⏱️ **灵活设置** - 秒/分钟单位切换，预设快捷按钮
- 📊 **实时进度** - 显示切分进度和当前处理片段
- 🎥 **视频预览** - 源视频和切分结果均支持播放预览
- 🔗 **链接导入** - 支持通过 MeowLoad CLI、MeowLoad API 或 ONCCG API 解析视频链接，下载后直接预览和切片
- 📂 **一键打开** - 快速打开输出文件夹
- 🌙 **主题切换** - 支持 Light/Dark 主题切换

---

## 🎥 支持格式

| 输入格式 | 输出格式 |
|---------|---------|
| MP4, MKV, AVI, MOV, WebM, FLV, WMV, M4V | 与输入格式相同 |

---

## 📦 系统要求

### 运行要求
- **macOS** 10.15+ (Catalina 或更高版本)
- **FFmpeg** 已安装（用于视频处理）

### 开发要求
- Node.js 18+
- Rust 1.70+
- FFmpeg 4.0+
- 可选：`meowload` CLI（用于默认链接解析下载）
- 可选：`hhm_key` 或 `MEOWLOAD_API_KEY`（用于 MeowLoad API 解析）

---

## 🚀 快速开始

### 方式一：下载预编译版本

1. 从 [Releases](https://github.com/yourname/video-clipping/releases) 下载最新的 `.dmg` 文件
2. 打开 DMG，将 `Video Clipping.app` 拖入 Applications 文件夹
3. 首次运行可能需要在「系统偏好设置 > 安全性与隐私」中允许运行

### 方式二：从源码构建

```bash
# 克隆仓库
git clone https://github.com/yourname/video-clipping.git
cd video-clipping

# 安装依赖
npm install

# 开发模式运行
npm run tauri dev

# 构建生产版本
npm run tauri build
```

---

## 📖 使用教程

### 1️⃣ 选择视频文件

- **方式 A**：直接将视频文件拖拽到虚线框内
- **方式 B**：点击虚线框区域，在文件选择器中选择视频
- **方式 C**：在「链接导入」中粘贴视频链接，选择 `MeowLoad CLI`、`MeowLoad API` 或 `ONCCG API` 后下载

选择后会自动识别视频时长并显示文件名。

### 1.1 链接导入

「链接导入」适合先把在线视频下载到本机，再进入同一个预览和切片流程。

- `MeowLoad CLI`：默认解析方式，调用系统中的 `meowload info` 获取媒体信息，再由应用下载选中的视频资源。
- `MeowLoad API`：调用 `https://api.meowload.net/openapi/extract/post` 解析视频，API key 从 `MEOWLOAD_API_KEY` 或 `hhm_key` 环境变量读取。
- `ONCCG API`：调用 ONCCG API 解析视频，保留原始响应和候选媒体列表，便于后续分析不同平台。
- 默认清晰度是 `最低`，也可以切换为 `最高`。
- 下载文件默认保存到 `~/Movies/VideoClippingDownloads/`，也可以在「链接导入」中选择自定义下载目录；选择后会在本机记住。
- 每次链接导入都会保存 `_raw/` 目录，包含原始链接、解析响应和候选资源。
- 代理配置在右上角「设置」菜单中统一管理，支持两种导入方式：
  - 粘贴 Clash/mihomo 订阅或配置链接。
  - 从本地选择 `.yaml` / `.yml` 配置文件。
- 代理节点会从配置中的 `proxies:` 自动识别；默认选择包含香港/港/HK/Hong Kong 的节点，也可以手动切换。
- 代理启用后只影响 API 解析方式的请求和媒体下载，`MeowLoad CLI` 会忽略该代理设置；代理不会修改系统代理。

如果需要覆盖 ONCCG Key：

```bash
export ONCCG_KEY="你的 ONCCG key"
export ONCCG_TYPE="dsp"
npm run tauri dev
```

如果 `meowload` 不在常规 PATH 中，可以指定：

```bash
export MEOWLOAD_PATH="/path/to/meowload"
npm run tauri dev
```

### 1.2 语音转文字

选择本地视频或链接下载完成后，页面会显示「语音转文字」面板。

- 模型引擎可选择 `whisper.cpp` 或 `FunASR`。
- 如果下载阶段拿到了独立音频文件，会优先使用下载音频转写。
- 如果当前输入是视频文件，会自动用内置 FFmpeg 分离为 16k 单声道 wav 后再转写。
- 转写结果会直接显示在页面上，并保存到视频所在目录的 `_transcripts/` 中。

whisper.cpp 推荐在右上角「设置」中填写 whisper.cpp 根目录，例如：

```text
/Users/qindongliang/Documents/vps/whisper.cpp
```

应用会自动识别：
- `build/bin/whisper-cli`、`build/bin/main`、`whisper-cli` 或 `main`
- `models/` 目录下的 `ggml-*.bin` 模型
- 点击「检测」后会显示识别到的程序路径，并列出可用模型；默认优先选择 `ggml-large-v3-turbo.bin`，也可以手动切换模型。

也可以使用环境变量兜底：

```bash
export WHISPER_CPP_BIN="/path/to/whisper-cli"
export WHISPER_CPP_MODEL="/path/to/ggml-model.bin"
npm run tauri dev
```

FunASR 可配置本地模型路径：

```bash
export FUNASR_BIN="/path/to/funasr"
export FUNASR_MODEL="/path/to/paraformer-zh"
export FUNASR_VAD_MODEL="/path/to/fsmn-vad"
export FUNASR_PUNC_MODEL="/path/to/ct-punc"
npm run tauri dev
```

### 2️⃣ 预览视频（可选）

选择视频后，点击「预览视频」按钮可以播放预览：
- ▶️ 播放/暂停
- 进度条拖拽跳转
- 🔊 音量调节

### 3️⃣ 设置切分时长

- 在输入框中输入每段视频的目标时长
- 点击「秒」或「分钟」切换单位
- 或使用快捷按钮选择预设时长：
  - 30秒 | 1分钟 | 5分钟 | 10分钟 | 30分钟

底部会显示预计切分的片段数量。

### 4️⃣ 选择输出目录

- 默认输出到源视频所在目录
- 点击「选择...」按钮可更改输出位置

### 5️⃣ 开始切分

点击 **「🚀 开始切分」** 按钮开始处理。

- 处理过程中会显示进度条
- 显示当前正在处理的片段编号
- 处理完成后显示所有输出文件列表

### 6️⃣ 查看结果

- 切分完成后，输出文件以 `原文件名_000.mp4`、`原文件名_001.mp4` 格式命名
- 点击任意输出文件可预览播放
- 点击「打开文件夹」可直接跳转到输出目录

---

## ⚙️ 设置菜单

点击右上角的设置按钮可统一管理：
- 自动保存主题偏好
- 中英文语言切换
- whisper.cpp 根目录检测和默认模型选择
- 临时代理配置、节点选择与测速

---

## ⚙️ 高级配置

### FFmpeg 安装

#### macOS (使用 Homebrew)
```bash
brew install ffmpeg
```

#### 验证安装
```bash
ffmpeg -version
ffprobe -version
```

### 环境变量

如果 FFmpeg 不在系统 PATH 中，可以设置环境变量：

```bash
export PATH="/path/to/ffmpeg/bin:$PATH"
```

---

## 🛠️ 开发指南

### 项目结构

```
video-clipping/
├── src/                    # React 前端源码
│   ├── components/         # UI 组件
│   │   ├── FileDropZone.tsx    # 文件拖拽上传
│   │   ├── RemoteUrlImporter.tsx # 视频链接导入
│   │   ├── AppSettingsMenu.tsx # 主题、语言与代理设置
│   │   ├── TranscriptionPanel.tsx # 语音转文字
│   │   ├── DurationInput.tsx   # 时长设置
│   │   ├── OutputSelector.tsx  # 输出目录选择
│   │   ├── ProgressBar.tsx     # 进度显示
│   │   ├── ResultList.tsx      # 结果列表
│   │   ├── VideoPlayer.tsx     # 视频播放器
│   ├── contexts/           # React Context
│   │   └── ThemeContext.tsx    # 主题状态管理
│   ├── hooks/              # React Hooks
│   │   └── useVideoSplit.ts    # 视频切分逻辑
│   │   └── useRemoteDownload.ts # 链接下载逻辑
│   ├── App.tsx             # 主应用
│   └── index.css           # 样式文件
├── src-tauri/              # Rust 后端源码
│   └── src/
│       ├── lib.rs          # Tauri 入口
│       ├── commands.rs     # 命令处理
│       ├── downloader.rs   # MeowLoad / ONCCG 下载封装
│       ├── mihomo.rs       # 临时代理封装
│       ├── transcription.rs # 语音转文字封装
│       └── ffmpeg.rs       # FFmpeg 封装
├── package.json
└── tailwind.config.js
```

### 常用命令

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run tauri dev

# 构建生产版本
npm run tauri build

# 仅构建前端
npm run build

# 代码检查
npm run lint
```

### 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 18 + TypeScript |
| 构建工具 | Vite 5 |
| 样式方案 | Tailwind CSS 3 |
| 桌面框架 | Tauri 2.0 |
| 后端语言 | Rust |
| 视频处理 | FFmpeg |

---

## ❓ 常见问题

### Q: 切分速度如何？
**A:** 由于使用流复制（无需重新编码），切分速度非常快，通常每秒可处理 GB 级别的数据。

### Q: 切分会损失画质吗？
**A:** 不会。本工具使用 FFmpeg 的 `-c copy` 参数，直接复制视频流，不进行任何重新编码。

### Q: 为什么切分点不是精确的时间？
**A:** FFmpeg 在无损模式下会在最近的关键帧处进行切分，以保证视频可以正常播放。

### Q: 视频预览没有画面怎么办？
**A:** 请确保重启应用后再试。如果仍有问题，可能是视频编码格式不被浏览器支持。

### Q: 支持批量处理吗？
**A:** 当前版本暂不支持批量处理，该功能正在开发中。

### Q: 可以在 Windows 上运行吗？
**A:** 代码架构支持跨平台，但当前仅在 macOS 上测试。Windows 版本即将推出。

---

## 📝 更新日志

### v0.1.0 (2024-12-24)
- 🎉 首次发布
- ✨ 基础视频切分功能
- ✨ 拖拽上传支持
- ✨ 实时进度显示
- ✨ 视频预览播放
- ✨ Light/Dark 主题切换
- ✨ 现代化深色 UI

---

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源。

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 提交 Pull Request

---

## 📧 联系方式

如有问题或建议，请通过以下方式联系：

- 提交 [GitHub Issue](https://github.com/yourname/video-clipping/issues)
- 发送邮件至 your-email@example.com

---

<p align="center">
  Made with ❤️ using Tauri + React + Rust
</p>
