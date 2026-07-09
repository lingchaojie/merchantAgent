# 补充：Salesforce Agentforce 基础设施/模型/部署细节

> 说明：本文件是"02 国外竞品"调研的子代理产出，回传父代理失败，单独落盘保存。数据截至 2026 年 7 月。

- **运行基础设施：**Agentforce 跑在 **Hyperforce**（AWS/GCP/阿里云），覆盖 17 国 / 25 区域。
- **模型阵容：**Salesforce 默认（GPT-4o）、AWS 托管的 Claude Sonnet（Bedrock），以及经 Models API 接入的 OpenAI/Anthropic/Google/Amazon/NVIDIA；还有 Salesforce 自研 xGen-Sales/xLAM/CodeGen 及 BYOLLM（自带模型）。
- **信任边界（Trust Boundary）三档：**推理相对 Salesforce 信任边界分三档；Bedrock 上的 Anthropic 完全在边界内（2025 年 10 月的合作进一步强化）。
- **数据驻留：**CRM 数据钉定牢固（Hyperforce 区域 + EU Operating Zone）；区域锁定的第三方 LLM 推理是主要开放不确定项。
- **接入渠道/触点：**Slack、增强消息渠道（SMS/WhatsApp/Messenger/Apple/LINE/Web）、语音、应用内、API 全支持。
- **版本时间线：**Agentforce 3 于 2025-06-23 发布（Command Center 基于 OpenTelemetry、支持 MCP、Atlas 故障转移）；可观测性子特性约 2025 年 11 月 GA；总品牌更名为 "Agentforce 360"。

**对我们的启示：**
- 大厂已把 **MCP** 作为一等公民纳入 agent 平台（Agentforce 3 Command Center 明确支持 MCP）——印证 MCP 是企业连接器的行业标准方向。
- **BYOLLM + 多模型路由 + 信任边界分档**是企业级刚需：客户会要求"敏感推理留在边界内/私有化"。我们的架构应从一开始就支持模型可插拔与推理位置分级。
- **可观测性/Command Center（基于 OpenTelemetry）**是企业 agent 平台的标配运营能力，不只是 demo。
