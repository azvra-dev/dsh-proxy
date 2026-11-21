# dsh-proxy

为 DSH 选择上网方式。左侧边栏点 **配置代理**，选择 **不使用代理** 或 **使用系统代理**，立即生效，无需重启。

同一页可测 GitHub、Google、YouTube、Claude 的访问延迟。

## 安装

插件页填：

```
https://github.com/azvra-dev/dsh-proxy
```

需要机器上有 git，且 DSH 是在装 git 之后启动的。

## 限制

- 仅支持 http(s) 代理，SOCKS 和 PAC 不可用
- 系统代理仅 Windows
- 回环流量始终直连
