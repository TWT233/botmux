# Task 6: 持久 BTW 运行时交付报告

## 交付内容

- 新增 detached、单例、认证的 BTW runtime 入口、客户端与服务器：
  `src/index-btw-runtime.ts`、`src/features/btw/runtime-client.ts`、
  `src/features/btw/runtime-server.ts`。
- 将 `btw-runtime` 接入 Node/Bun/standalone 的 self-spawn 与静态 CLI 派发。
- runtime descriptor 只发布 `pid`、`startIdentity`、`socket`、
  `protocolVersion`、`buildId`、`epoch` 六个字段；token 独立保存在
  `runtime.token`。
- 通过 UID-owned `0700` runtime 目录与 `0600` descriptor/token/socket，
  加上每次连接的 token、协议版本与 epoch 认证，限制本地运行时访问。

## 收尾修复与回归覆盖

1. 测试 runtime 清理改为记录每个实际 spawn 的 descriptor 与 token，并且只在
   `pid + startIdentity` 仍精确匹配时请求关闭或发信号。篡改 `runtime.json`
   不会再让 teardown 丢失原 runtime。
2. 新增非空且 protocol 不兼容 runtime 的回归：`ensureBtwRuntime` 明确拒绝，
   保留原 PID/start identity 和可认证 socket，不创建 replacement。
3. 新增陈旧 socket 回归：descriptor 的 PID/start identity 虽仍存活、但 socket
   无法完成认证时，在 singleton lock 内立即 fail closed（
   `btw runtime is live but unavailable or unauthenticated`），不等待十秒发布超时，
   不终止也不替换该 runtime。
4. 已保留 malformed/oversized frame、每 socket 64 条待处理请求上限、错误 token、
   stale epoch、PID reuse、兼容 build reuse、空 runtime protocol replacement、
   projection wake app scope 与 watcher reconnect 的覆盖。

## Projection watcher 与队列审计

- `watchProjectionWakes()` 每次调用通过 `createAuthenticatedSocket()` 建立独立的
  已认证 socket，避免 watcher 与普通 RPC 共享两个 newline reader。
- server 使用 `Set<string>` 聚合 app ID，并通过一次 microtask flush；同一 app 的
  并发 submit wake 被合并，不依赖订阅者存在，也不改变 durable pending list。
- 单连接 frame dispatch 在解析批次时同步计数，超过 64 条待处理请求即关闭连接，
  因而快速 handler 不能掩盖输入洪泛。

## Peer-UID 校验限制

本环境为 Linux + Node v24.18.0。`node:net` 的 `Socket.prototype` 和
`Server.prototype` 均没有 `getPeerCredentials`，安装的 Node/Bun 类型声明中也没有
`getpeercredentials`、`peer cred` 或 `SO_PEERCRED` 可用接口。标准 Node Unix socket
API 因此无法可靠读取对端 UID。

没有伪造 peer-UID 成功路径：runtime 以 socket 文件 `0600`、UID-owned `0700`
目录、随机 256-bit token、每请求 epoch/protocol 校验 fail closed。若将来平台提供
可信 peer credential API，需在 `authenticateSocket()` 的 token 前加入同 UID 检查，
并在对应平台新增 mismatch 负向测试；在当前 API 表面无法诚实地实现该测试。

## 遗留进程处置

此前泄漏的 PID `80638` 已在清理前逐项核对：

- cmdline 指向本 worktree 的 `src/index-btw-runtime.ts`；
- `SESSION_DATA_DIR` 为 `botmux-btw-runtime-auth-*` 临时目录；
- `BOTMUX_BTW_RUNTIME_CHILD=1`；
- `readProcessStartIdentity(80638)` 为 `399898725`。

随后只对该匹配 identity 的 PID 发送 `SIGTERM`；复查 start identity 已不存在。

## 验证

```text
./node_modules/.bin/vitest run --project unit test/btw-runtime-auth.test.ts test/cli-subcommand-spawn-form.test.ts test/cli-runner-compiled-entries.test.ts
# 3 files, 29 tests passed

./node_modules/.bin/vitest run --project e2e test/btw-runtime-process.e2e.ts
# 1 file, 4 tests passed

bun run build
# passed

git diff --check
# passed
```
