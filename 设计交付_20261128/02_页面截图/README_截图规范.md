# 页面截图规范

## 一、目录约定

```
02_页面截图/
├── 00_现状/      改版前的截图（基线）
└── 01_改版对照/   改版后的同机位同状态截图
```

两个目录里的文件**同名**，靠目录区分前后；对照时直接左右并排。

## 二、命名规则

```
{页面key}_{状态}_{字号档}_{日期}.png
```

示例：`home_default_standard_20261128.png`、`settings_xlarge_large_20261128.png`

- 页面 key：`home` `consultation` `appointment` `settings` `triage` `nav` `detail`
- 状态：`default` / `loading` / `empty` / `error` / `popup`（有弹层的页各存一张）
- 字号档：`standard` / `large` / `xlarge`
- 只允许小写字母、数字、下划线，不要中文文件名（跨工具兼容）

## 三、必拍清单

| 页面 | standard | large | xlarge |
| --- | --- | --- | --- |
| 首页 home | default + loading + empty + error | default | default |
| AI 问诊 consultation | default + 对话态 | default | — |
| 预约挂号 appointment | default + 弹层 | default | — |
| 设置 settings | default | default | default + popup |
| 智能导诊 triage | default + result | default | — |
| 院内导航 nav | default + 空态 | default | — |
| 科普详情 detail | default + 视频态 | default | — |

## 四、机位与参数

- 模拟器统一 **iPhone 13（390×844，@3x）**，导出 @2x 即可；真机复测再补一组。
- 同一页前后对照必须**同机型、同字号档、同滚动位置**，否则对照无效。
- 截图前清掉调试浮层，滚动到页面顶部；有长列表的页另拍「滚到底」一张，命名加 `_bottom`。
- 截图不要压缩，PNG 原图存，后续要量像素和圆角。

## 五、每张截图的记录要求

在 `06_验证记录/截图清单.md` 里逐条记：文件名、页面、状态、档位、发现问题（一句话）、对应改动。没有记录的截图视为无效素材。
