# 运行故障排查

本地回归与数据库副本可以验证代码，不能还原最新生产故障。排查时需要生产运行位置、故障时间和相同时间窗口的应用、代理日志；时间包含时区。不需要提供管理员口令、API Key 或 Cookie。

## 对比应用直连与代理入口

在应用宿主机执行，替换端口与公网域名；每个请求最多等 5 秒，不执行扫描或账号操作：

```bash
date -Is
curl --max-time 5 -sS -o /dev/null -w 'direct status=%{http_code} total=%{time_total}s\n' http://127.0.0.1:12333/health
curl --max-time 5 -sS -o /dev/null -w 'proxy status=%{http_code} total=%{time_total}s\n' https://tasks.example.com/health
docker compose ps
docker stats --no-stream
docker compose logs --since 30m --tail 2000 --timestamps app
```

在未修改状态的前提下，于故障发生时与恢复后各采集一次。`/health` 仅表示应用能处理一个简单请求，不检查 Emby、TMDB、邮件或全部数据库查询。若直连也慢，检查容器 CPU、内存、重启与应用日志；若直连正常而公网慢，检查 TLS、代理及隧道。同一时刻的对照只是定位线索，不能单凭一次结果确定根因。

## 对齐请求与扫描记录

应用正常结束的 API 请求记录 `request`、状态与 `durationMs`。未完成的响应关闭记录 `request_aborted`，状态留空，避免把默认 200 记成成功。该事件也可能由用户切页或前端超时取消产生，不能单独认定为后端故障；服务端已经开始的写操作可能仍在完成。日志不含查询参数或请求正文。健康检查及日志查询沿用排除规则。

对照同一窗口的扫描开始、完成、失败事件，以及扫描历史的起止时间。若应用数据库日志因写锁或队列容量缺失，继续检查容器标准输出中的事件和 `log_buffer_overflow`，不要仅凭管理页的日志列表认定没有请求。

代理可使用 [部署文档](deployment.md) 中的时长日志格式，记录状态、请求总时长、上游响应时长与上游状态。核对实际代理等待预算、浏览器超时、容器重启时间；不直接通过延长全部超时掩盖慢查询。

项目目前没有事件循环延迟监测；直连健康检查超时不能直接证明是主线程阻塞。`uncaught_exception` 和 `unhandled_rejection` 触发退出码 1，不再忽略后继续服务；对照事件、容器重启与代理请求时间，并查明异常类型。正常停机首次信号立即停止调度，应用最多等待 25 秒收尾，Compose 提供 30 秒宽限；收尾超时或失败以非零状态退出。

## 私人库只在部分客户端显示

后台「系统日志」搜索「私人库诊断」，或查看容器输出的 `virtual_library_identity` 事件。记录中的 `client` 是声明客户端的固定类别，`route` 是接口类别，不含真实路径、账号或令牌。常见原因：

| reason | 含义 |
| --- | --- |
| `recorded` | 已从成功登录响应保存身份绑定 |
| `invalid_json`／`decoding_failed`／`unsupported_encoding` | 登录响应解析或解压失败 |
| `persistence_error` | 登录身份保存失败 |
| `login_proof_missing` | 当前请求没有可识别且已确认归属的登录凭据 |
| `validation_failed`／`validation_unavailable` | 原客户端凭据复核被拒绝，或请求失败／超时 |
| `member_unavailable` | 上游账号未匹配管理员绑定或唯一可用会员 |
| `private_scope_ready` | 已确认身份并计算范围，`privateLibraryCount` 是当前可见本地虚拟库数，含自有库及本地订阅库，不包含 TgtoDrive 等外部库 |
| `no_personal_library` | 已确认身份，但当前没有可见的本地虚拟库；不能据此判断外部订阅为空 |
| `discovery_result` | 已检查实际返回的目录或首页分区，记录返回库数量、范围、账号类型、分页及响应结构 |
| `discovery_passthrough` | 发现请求按原响应透传，没有核对返回条目数量 |

`decoded` 仅表示登录响应 JSON 可读，需结合 `recorded` 判断身份是否保存；`private_scope_ready` 表示服务端确认的可见范围，不代表播放器已渲染入口。重复的同类发现记录每分钟最多一条。排查时提供播放器名称、版本、操作时间及上述记录即可，无需提供账号密码或令牌。相关回归不替代实际播放器联调。

响应诊断中的 `visibleLocalLibraryCount`、`enabledExternalLibraryCount` 是已确认的范围；`localLibraryCount`、`externalLibraryCount` 是实际响应内匹配的去重库数。`accountType` 区分管理员、会员、双重身份或未确认身份，不记录账号 ID。`bodyShape=other` 表示无法识别目录结构；`recognizedLibraryDiscovery=false` 表示根目录返回了库列表，但查询未被识别为可叠加的发现请求。普通影片搜索不计作媒体库目录。1.5.7 发行版仅有原范围诊断，新增响应诊断需运行包含此改动的版本。

网页和各播放器使用独立的登录凭据，一端重新登录不会替其他端建立记录。已保存的身份在同一数据库、上游地址与令牌不变时，正常容器重启或更新后仍应保留；持续丢失需要核对数据挂载、上游配置与身份记录，不能把每次重新登录视为修复完成。

## 容器验证边界

独立冒烟入口见 [测试说明](../tests/README.md)。脚本使用临时数据库和独立 Compose 项目，不检查生产容器。Docker daemon 不可用时退出码为 2，仅表示静态配置与构建已验证；运行时健康、持久化和只读文件系统仍未验收。

未取得真实日志或执行真实代理对照前，结论应明确列出已验证的本地行为与仍缺失的生产证据，不宣称生产卡顿或断连已经全部解决。
