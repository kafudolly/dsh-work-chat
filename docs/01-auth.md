# M1 · 凭据与登录

## 重要变更（P0 实测后）

**密码登录不可用**：DeepSeek 网页端前置 AWS WAF，密码登录实测返回 `422 {"detail":[{"loc":"body"}]}`；
社区同类插件 [deepseek-web-import](https://github.com/CwavGuy/deepseek-web-import) 的已知限制也写明
「密码登录会被人机验证（AWS WAF）拦截，必须使用 userToken 方式」。裸 curl 更直接被 `429` 风控页拦。

因此登录链路的优先顺序改为：

1. `userToken`（推荐）：用户在设置页粘贴，或写进 `secrets/deepseek-credentials.json` 的 `userToken` 字段；
2. 账号密码：仅作备用，遇到 `422 body` 时返回 `stage='waf'` 并提示改用 token。

`userToken` 获取方式（写进设置页说明里）：网页版按 F12 → Application → Local Storage → `userToken`；
或任意请求头里的 `authorization: Bearer <token>`。有效期约数小时到数天，失效后重新复制。

## 目标

用户只需在设置页填一次账号密码，插件即可换取网页端 `userToken`，并在 token 失效时自动重登。

## 已确认的行为

- **登录顺序：先邮箱+密码，失败后自动尝试手机号+密码**（你的要求 1）。
- 两种方式都失败时，设置页显示失败阶段（不带凭据）。
- 密码明文存本机（你的确认 3）。注意：Windows 上 `0600` 不构成权限隔离（仅只读位），需要更强隔离时用 `icacls` 收紧目录；插件不自动执行系统命令。

## 涉及文件

- `src/host/auth.js`：登录、`deviceId`、token 解析、脱敏。
- `src/host/store.js`：`credentials.json` / `auth.json` 读写。
- `src/host/routes.js`：`GET/POST /workchat/credentials`、`POST /workchat/login-test`。
- `client.js`：设置页「DeepSeek 网页账号」表单。

## 实现要点

1. **凭据读取优先级**：`$DSH_HOME/workchat/credentials.json` → 插件目录 `secrets/deepseek-credentials.json`（开发夹具）。
2. **候选顺序**：`preferredLogin` 默认 `email-first`。
   - 候选 A：`{ email, password, device_id, os }`
   - 候选 B：`{ mobile, area_code, password, device_id, os }`
   - 只尝试**已填写**的候选；A 失败（非网络类错误）再试 B。
3. **deviceId**：首次生成 UUID，登录成功后回写 `credentials.json`；之后固定复用（换 ID 可能触发风控）。
4. **token 解析**：`data.biz_data.user.token` → `data.biz_data.token` → `data.token` 兜底；都取不到抛 `shape` 阶段错误。
5. **token 缓存**：内存 `state.token` + `auth.json`；启动时 `loadAuth()` 恢复。
6. **失效重登**：接口层抛 `unauthorized` 时调用一次 `relogin()`（同一把 credentials），失败则标记 `needsLogin`，不循环重试。
7. **风控**：429 直接抛 `rate-limited`，前端提示"稍后重试"；不自动重试。
8. **脱敏**：`redact()` 在写日志前替换密码/token；`routes.js` 的 `safeError()` 只放行 `stage/message/code/status`。

## 测试计划

| 用例 | 期望 |
|---|---|
| 只填邮箱 | 只尝试 A；失败报 `biz/http` 阶段 |
| 只填手机号 | 只尝试 B |
| 两者都填、A 密码错 | 自动尝试 B，最终以 B 结果为准 |
| 密码为空 | 不发起请求，报 `input` 阶段 |
| 429 | `rate-limited`，提示稍后再试 |
| token 存在但字段路径不同 | 依次兜底，全失败报 `shape` |
| 响应含 token | `login-test` 只回 `tokenPresent: true` |

## 验收

- [ ] `node tools/probe-login.mjs` 能打印 `登录成功 { tokenPresent: true }`（需填凭据）。
- [ ] 设置页保存后，`$DSH_HOME/workchat/credentials.json` 出现且权限 0600。
- [ ] `GET /workchat/credentials` 不含 `password` 字段。
- [ ] 故意输错密码：返回 `stage` 明确，响应与日志无密码。

## 风险

- 网页端可能要求 PoW（`x-ds-pow-response`）：P0 探测若出现，追加 SHA3-256 求解器（本模块内新增 `pow.js`，不改接口形状）。
- 邮箱/手机号联合体字段名以 P0 实测为准；本模块只依赖 `buildLoginBody()` 一处。
