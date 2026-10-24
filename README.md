# R2 Manager

> 专为 Cloudflare R2 打造的高性能、跨平台现代化桌面客户端。基于 Tauri 2 + Rust 核心构建，兼具原生级别的极速性能与现代审美交互。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8D8?logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-2021-orange?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev/)

---

## 特性亮点

- **极致性能**：底层采用 Rust 与 AWS S3 官方 SDK 实现并发请求与流式传输，内存占用极低。
- **递归上传与拖拽**：支持文件与整文件夹无缝拖拽上传，自动解析多层目录结构。
- **并发与断点续传**：大文件自动分片、多线程并行上传，支持并发限制与未完成分片清理。
- **多配置与多桶支持**：支持保存多个 R2 账户配置，一键无缝切换存储桶。
- **安全第一**：凭证通过系统钥匙串（macOS Keychain / Windows Credential Manager）加密存储，不经过任何第三方服务器。
- **操作历史审计**：本地记录删除、重命名与目录创建历史，支持一键清空与回溯检索。
- **现代交互设计**：支持明暗双色主题自适应、小屏响应式紧凑模式、类似 macOS Finder 的路径导航。

---

## 技术架构

- **桌面运行时**：[Tauri v2](https://tauri.app/)
- **后端核心**：Rust (tokio + aws-sdk-s3 + keyring)
- **前端交互**：React 18 + TypeScript + Vite (Vanilla CSS 设计系统)

---

## 本地开发与构建

### 运行前准备

确保您的系统已安装：
- [Node.js](https://nodejs.org/) (>= 18)
- [Rust & Cargo](https://rustup.rs/) (>= 1.75)

### 安装依赖

```bash
npm install
```

### 启动开发环境

```bash
# 启动桌面端调试（热重载）
npm run app:dev
```

### 构建生产包

```bash
npm run app:build
```

---

## 安全与隐私

- **无中继服务**：所有网络请求由本地直接发往 Cloudflare R2 官方 API 端点。
- **凭据隔离**：Secret Access Key 存储于系统原生钥匙串，不会在明文文件中留存。

---

## 开源协议

本项目基于 [MIT 协议](LICENSE) 开源。

Copyright (c) 2026 dodo2dodo
