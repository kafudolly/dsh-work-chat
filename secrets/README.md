# secrets/ —— 本机凭据，禁止提交、禁止外传

`deepseek-credentials.json` 用来放你的 DeepSeek 网页账号，供**开发期程序**测试登录：

## 字段

| 字段 | 说明 |
|---|---|
| `userToken` | **推荐**。网页版 F12 → Application → Local Storage → `userToken`；或请求头 `authorization: Bearer …` 的值 |
| `email` | 邮箱登录时填；与 `mobile` 二选一（密码登录可能被 WAF 拦截） |
| `mobile` + `areaCode` | 手机号登录时填，区号默认 `+86` |
| `password` | 账号密码（备用方式） |
| `deviceId` | 留空即可，首次登录后插件会自动生成并回写 |
| `os` | 保持 `web` |

> 实测：DeepSeek 会用 AWS WAF 拦截密码登录（返回 `422 {"detail":[{"loc":"body"}]}`），
> 所以优先填 `userToken`。token 有效期约数小时到数天，失效后重新复制保存。

## 边界约定

- **AI 助手不读取本文件**：所有开发、调试、改代码的动作都不会打开它。
- 只有 `tools/probe-login.mjs` 这类脚本在你要验证登录时才读取，并且**只打印** HTTP 状态 / 业务码 / token 是否存在，绝不打印密码或 token 原文。
- 本目录已被 `../.gitignore` 排除（`secrets/*.json`），不会随插件包分发。
- 验证完成后如需更安全，可把设置页切到"只存 token"模式（见方案 §四）。

## 手动验证登录

```powershell
node tools/probe-login.mjs
```

预期输出形如：

```
读取凭据：邮箱模式
登录成功 { tokenPresent: true, deviceIdTail: "a1b2c3", elapsedMs: 1234 }
```
