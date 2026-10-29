# 更新记录

## 0.1.2

配置热重载。

- `config.json` 改动不再需要重启宿主：插件每 3 秒看一次文件的 `mtimeMs:size`，变了就按新配置重建 controller 顶上，再把旧的关掉。改 `mode`（off / observe / active）、`groupIds`、`aliases`、`scheduler.*` 都在 3 秒内生效。
- 重建失败会回退：新 controller 起不来就保留旧的继续跑，只在日志里 warn，不会把正在工作的实例弄死。
- `observe` 换成 `active` 时，会顺手把已经挂着的 agent 重新 `tryAttach` 一遍，不用等下一轮挂载。
- 指纹用 `mtimeMs:size`，避免同一毫秒内连续两次写入被漏掉。
- 轮询句柄 `unref()`，插件 dispose 时 `clearInterval`，不会拖住宿主退出。

相对 `0.1.1` 只动了 `lib/host.mjs`（+75 行 / -0 行，其中一处是 `const controller` → `let controller`，一处是 `node:fs` 的 import 加了 `statSync`），完整 diff 见 `patch/host-config-hotreload.patch`。

补丁以 `0.1.1` 未修改版为基准，可用 `git apply` 打到旧版本上；本仓库里已经是打完的状态，不需要再打一次。

## 0.1.1

首个公开版本。
