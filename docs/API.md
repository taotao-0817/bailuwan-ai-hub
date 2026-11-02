# 核心 API

默认基址：`http://127.0.0.1:8788`。所有业务接口返回 JSON。除登录、健康检查和独立模拟服务接口外，均需要已登录会话。浏览器使用同源 `HttpOnly`、`SameSite` Cookie；有 `Origin` 的写请求必须通过来源校验。前端不存储长期密钥。

## 会话与读取

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | `{username,password}`，设置会话 Cookie |
| POST | `/api/logout` | 撤销当前会话 |
| GET | `/api/session` | 当前用户与角色 |
| GET | `/api/bootstrap` | 当前用户可访问的建筑、设备、任务、告警与摘要 |
| GET | `/api/events` | 认证 SSE，`update` 事件用于触发刷新 |
| GET | `/api/health` | 服务健康与模拟模式 |
| GET | `/api/audit/verify` | 管理员验证审计哈希链 |

## 控制与任务

| 方法 | 路径 | 请求要点 |
| --- | --- | --- |
| POST | `/api/commands` | `deviceIds[]`, `action`, `value`, `idempotencyKey` |
| POST | `/api/commands/:id/cancel` | `{}`，仅人工接管期间超级管理员可停止尚待回执的指令 |
| POST | `/api/scenes` | `mode`: work/off/night/eco/emergency；应急需 `confirmed` |
| POST | `/api/patrols` | `name`, `robotId`, `route[]` |
| POST | `/api/patrols/:id/action` | `action`: pause/resume/recall/cancel |
| POST | `/api/deliveries` | `title`, `from`, `to`, `weight`, 可选 `priority`、`recipient`、`idempotencyKey`。有配送调度权限时校验并直接派单，其他角色创建待审批申请。 |
| POST | `/api/deliveries/:id/action` | dispatch/pause/resume/recall/cancel/sign/archive/reassign |
| POST | `/api/automations/:id` | `enabled`，以及允许修改的场景/定时参数 |

设备动作限定为声明的能力，例如灯具 `power`/`brightness`、空调 `power`/`temperature`/`mode`、窗户 `open`。控制请求返回指令记录，初始 `pending`；随后由设备回执变为 `succeeded`、`failed`、`timed_out` 或取消状态。调用者必须跟踪终态，不能把请求被接受当作执行完成。

同一主体重复使用相同幂等键和相同请求应返回原结果；相同键绑定不同请求会产生冲突。高风险应急命令还需显式确认。后端同时校验角色、设备能力、值范围、设备在线状态和人工接管状态。接管期间停止待执行指令仅取消排队意图，不假设已回执动作可以撤销；真实设备的急停需要独立协议与硬件安全支持。

## 告警与应急

| 方法 | 路径 | 请求要点 |
| --- | --- | --- |
| POST | `/api/scenarios/security` | 生成安防模拟事件 |
| POST | `/api/scenarios/fire` | 生成明确标记的消防演练事件 |
| POST | `/api/alerts/:id/transition` | `action`: confirm/dispatch/resolve/review/archive；可附 `note`、`assignee` |
| POST | `/api/emergency/:id/execute` | `confirmed:true`、`idempotencyKey`，仅已确认的消防告警 |
| POST | `/api/takeover` | `action`: activate/release；`password`、`reason`、`confirmed:true` |

告警状态依次为 `detected → confirmed → dispatched → resolved → reviewed → archived`。消防演练在已确认后由应急执行接口进入联动阶段；动作、联动设备和结果写入时间线与审计。接管需要超级管理员再次验证身份；恢复检查失败时返回业务错误，保留接管状态。

## OA 与考勤

| 方法 | 路径 | 请求要点 |
| --- | --- | --- |
| POST | `/api/approvals` | `title`, `type`, 可选 `relatedId`、`description` |
| POST | `/api/approvals/:id/action` | approve/reject/transfer/withdraw/remind；可附 `note`、`assignee` |
| POST | `/api/attendance/:id/review` | `note`，有权人员复核异常 |

配送单自动生成关联审批。批准后的配送单才可调度，审批不替代设备可用性检查。转交人必须是已存在且具备审批权限的用户（用户 ID 或用户名）；转交后由指定审批人或管理员继续决策。权限申请只产生待管理员处理的执行结果，不直接提高权限。

## 错误与重试

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "当前角色无权执行此操作",
    "details": {}
  },
  "requestId": "请求追踪编号"
}
```

常见 HTTP 状态：`400` 参数或能力不匹配，`401` 未登录/身份校验失败，`403` 无权限，`404` 实体不存在，`409` 幂等或状态冲突，`423` 人工接管锁定，`429` 请求频率受限，`500` 服务异常。具体业务错误码以响应为准。重试设备控制必须复用原幂等键；遇到 `409` 应刷新业务状态并由用户决定下一步。

模拟服务调用 `POST /api/simulator/tick`，使用环境变量中的模拟令牌。该接口不是公开业务 API，禁止交给 Agent 或浏览器调用。


## v1.1 中枢接口

- GET /api/hub：统一资源、五类中枢任务、房间与岗位、模拟通知。普通用户只看到本人任务和通知。
- POST `/api/hub/plan` 接收 `goal`、可选 `type`、`params` 和 `idempotencyKey`。调度角色显式选择 `delivery` 时校验并派单。未指定类型时先返回可核对的任务，调用 `start` 后重新检查条件。高风险任务等待人工确认。
- POST /api/hub/events：fire 或 fall 事件，指定 buildingId/floor/note；关联安全事件并等待确认。
- POST /api/hub/tasks/:id/action：start/confirm/reject/pause/resume/cancel/complete/replan；confirm、reject、complete 保留核验记录。
- GET /api/twin/snapshot：统一展示端快照，见 TWIN-ADAPTER.md。

模型只返回结构化理解，由服务端复核会话与当前资源状态。会议时间要求未来 ISO 时刻，最长 12 小时，执行前再次校验。`hub.model` 给出解析模式与配置状态，`hub.deliveryPolicy` 给出本角色的配送策略。
