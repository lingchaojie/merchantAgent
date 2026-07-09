# merchantAgent 桌面壳（Electron + Vite + React + TypeScript）

对标 **Cursor / Codex 桌面 app**：Electron UI 壳 + 编译型后端干重活。Codex = Electron 壳 + Rust CLI；我们 = **Electron 壳 + Go 后端（agentd）**。编排/授权/RAG/连接器都在 Go 里，壳只管窗口、沙箱本地文件、类型化 IPC 桥。

## 技术栈
**electron-vite**（main/preload/renderer 一起打包 + HMR）· **React 18** · **TypeScript**（严格模式）· **Vitest**。

## 结构
```
desktop/
├─ electron.vite.config.ts    # 三端打包配置
├─ tsconfig.{json,node.json,web.json}   # node(main/preload) 与 web(renderer) 分离
├─ src/
│  ├─ shared/contract.ts       # ★ IPC 契约（唯一真源）：AgentAPI/Answer/Principal/Channels
│  ├─ main/                    # 主进程（特权侧，Node）
│  │  ├─ index.ts              #   BrowserWindow: contextIsolation+sandbox+nodeIntegration:false + CSP + 拦截外链
│  │  ├─ ipc.ts                #   IPC handlers（唯一特权桥，通道来自 contract）
│  │  ├─ fsguard.ts            #   ★ 路径沙箱：防 ../ 逃逸、覆盖写需 confirmed
│  │  ├─ fsguard.test.ts       #   vitest 安全用例（5 个）
│  │  └─ agentd.ts             #   连/spawn Go 后端（loopback HTTP，fetch）
│  ├─ preload/index.ts         # contextBridge 暴露类型化 window.agent（无 Node 泄漏给渲染层）
│  └─ renderer/                # 渲染层（React，无 Node）
│     ├─ index.html
│     └─ src/
│        ├─ main.tsx           #   React 入口
│        ├─ env.d.ts           #   window.agent 类型声明（绑定 contract）
│        ├─ App.tsx            #   顶层状态：身份 + 消息
│        ├─ styles.css
│        └─ components/        #   RoleSelect / ChatView(+MessageBubble) / Composer
└─ .gitignore                  # node_modules/ out/
```

## 安全模型（已落实，工程化后不变）
- **渲染层零 Node**：`contextIsolation:true` + `nodeIntegration:false` + `sandbox:true`；只见 preload 经 `contextBridge` 暴露的类型化 `window.agent`。
- **IPC 白名单 + 类型化**：通道名与请求/响应形状集中在 `shared/contract.ts`，main/preload/renderer 共享——形状漂移即编译报错。
- **路径沙箱**（`fsguard.ts`）：本地文件限定单一 workspace 根，`../`/绝对路径逃逸被拒，覆盖写需 `confirmed`。
- **CSP + 拦截导航**：WebView 只能连 loopback agentd（`127.0.0.1:8765`）；新窗口/外部导航一律拒绝。
- **身份（Phase 0 捷径）**：mock 用户下拉；生产改企微 OAuth 会话，`userId` 绝不由渲染层决定（见 `ipc.ts`/`agentd.ts` 注释）。

## 命令
```bash
npm install
npm test          # ✅ vitest：fsguard 安全用例（不需 Electron/显示，5 个）
npm run typecheck # ✅ tsc 双端（node + web），0 错误
npm run build     # ✅ electron-vite 三端打包 → out/
npm run dev       # 开发（HMR）
npm start         # 预览打包产物
npm run dist      # electron-builder 出安装包（在对应 OS 上）
```

### 在 WSL 里运行（本仓库环境已验证）
WSLg 提供显示，但 Chromium GPU 进程在 WSL 常崩，加 workaround：
```bash
./node_modules/.bin/electron . --disable-gpu --no-sandbox --disable-dev-shm-usage
```
> 已验证：electron-vite 三端打包成功、tsc 双端 0 错误、vitest 5/5、Electron 在 WSLg 干净启动、main 进程跑到位（创建 `~/.config/merchant-agent-desktop/workspace`）、零渲染层报错。**这些标志仅 WSL/CI 需要，真机 Windows/macOS 不需要。**

### 端到端联调
```bash
cd ../backend && docker compose up -d && OPENFGA_API_URL=http://localhost:18080 go run ./cmd/agentd  # :8765
cd ../desktop && npm run dev -- --disable-gpu --no-sandbox   # WSL；真机去掉标志
```
切换顶部身份问 "SO-1001 进度/利润/齐套"，看**同问不同权**。

## 已知项
- `npm install` 报若干 high 漏洞，集中在 **electron-builder 开发期依赖**（打包工具链），非运行时；发版前 `npm audit` 复核。
- 本地文件命令（readFile/writeFile）主/preload 已就绪，UI 暂未接。
- 待补：企微扫码登录替换 mock、流式输出、Markdown/代码渲染、破坏性操作确认弹窗、应用图标。
