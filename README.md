# 医疗健康 AI 微信小程序（楚大夫 · 患者端 AI 助手「小安」）

面向中老年用户的适老化医疗健康小程序：智能导诊、AI 问诊、AI 养生、分步挂号、院内导航、健康科普与医生工作台一站式服务。

## 功能特性

- **智能导诊**：本地规则引擎 + 后端 AI 融合，引导患者选择科室
- **AI 问诊 / AI 养生**：基于大模型的多轮健康问答与养生建议
- **分步挂号**：科室 → 医生 → 时段 → 确认的渐进式挂号流程
- **院内导航**：Canvas 平面图导航
- **健康科普**：结构化健康知识内容
- **音色管理**：Qwen3-TTS 语音合成与音色切换
- **医生工作台**：医生端问诊与回复管理

## 技术栈

| 端 | 技术 |
| --- | --- |
| 前端 | 原生微信小程序（WXML + WXSS + JavaScript），适老化大字三档 / 高对比设计 |
| 后端 | Python FastAPI（AI 服务）+ Java Spring Boot（业务服务），统一网关单入口（:8000） |

## 目录结构

```
├── backend/        # 后端：edge-gateway / ai-service / business-service
├── miniprogram/    # 微信小程序前端（pages / services / utils / components / 分包）
├── README.md       # 本文件
└── LICENSE         # MIT 许可证
```

## 快速开始

1. **后端**：分别启动 `ai-service`（Python FastAPI）与 `business-service`（Spring Boot），再启动 `edge-gateway` 反向代理统一入口。
2. **前端**：使用微信开发者工具导入 `miniprogram/` 目录，在 `miniprogram/config/env.js` 中配置网关地址后编译运行。
3. **配置**：后端各服务的密钥与数据库连接均通过环境变量注入（参考各服务配置模板），请勿在代码中硬编码凭据。

## 许可证

[MIT](LICENSE)
