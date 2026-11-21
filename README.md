# dsh-proxy

为 DSH 选择上网方式。左侧边栏点 **配置代理**：

- **不使用代理** —— 直接连接
- **使用系统代理** —— 走 Windows Internet 选项里的代理

切换后立即生效，无需重启。

## 原理

DSH 启动时只读一次代理环境变量，之后不会再变。本插件在运行时替换全局 dispatcher：

| 接口 | 作用 |
|---|---|
| `GET /dsh-proxy/state` | 当前模式、实际出站路径、Windows 代理读数 |
| `POST /dsh-proxy/mode` | `{"mode":"direct"}` 或 `{"mode":"system"}` |
| `GET /dsh-proxy/latency` | 四个站点并行测速，各自 10 秒上限 |

选择保存在 `<DSH_HOME>/dsh-proxy.json`，下次启动自动沿用。没选过之前不安装任何策略，只显示启动时的状态。

## 始终直连的部分

- 回环流量（`localhost`、`127.0.0.0/8`、`::1`）
- 模型编写的 Node 脚本（工作流、ptc 运行时）
- OTLP 遥测（走 `node:http`）

## 限制

- 只支持 http(s) 代理。系统代理是 SOCKS 或 PAC 脚本时，页面会说明不可用，不会半生效。
- 系统代理模式仅 Windows 可用。
- `ProxyOverride` 会转换而非照搬：`*.example.com` 可用，`127.*`、CIDR、`<local>` 会被丢弃（回环本来就直连）。
- 系统代理地址若带密码，会成为环境变量，DSH 启动的命令都能读到。

## 文件

```
index.js            Host：读注册表、切换代理、JSON 接口
client.js           浏览器：侧边栏入口与页面、站点图标
cordis.patch.yml    Bundle patch
locale/{en,zh}.json 插件管理器标题与描述
icon.svg            插件图标
test/check.mjs      清单、语言包、客户端自检
test/switch.mjs     真实系统代理下的切换测试
```

用 Harness 自带的运行时跑测试（需要读 app.asar）：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "$env:DSH_NODE_EXECUTABLE" test/check.mjs
& "$env:DSH_NODE_EXECUTABLE" test/switch.mjs
```
