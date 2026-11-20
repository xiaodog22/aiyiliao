# AutoComplete 组件使用示例（IDEA 式输入自动补全）

> 组件文件：[app/web/autocomplete.js](file:///d:/asr_chaoshanhua/asr_chaoshanhua_V01/_V01/wechar/clinic-his/app/web/autocomplete.js)（零依赖，约 300 行）
> 已在 [index.html](file:///d:/asr_chaoshanhua/asr_chaoshanhua_V01/_V01/wechar/clinic-his/app/web/index.html) 加载；后端静态白名单注册于 [main.py](file:///d:/asr_chaoshanhua/asr_chaoshanhua_V01/_V01/wechar/clinic-his/app/main.py) `STATIC_FILES`（新增静态文件须同步注册并重启）。

## 1. API

```js
AutoComplete.attach(inputEl, opts)   // 返回实例（hide()/destroy()）
```

| 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `items` | 数组或 `() => 数组` | — | 本地字典数据源（与 `remote` 二选一） |
| `remote` | `async q => 数组` | — | 远程搜索（如 `/api/v1/patients?q=`） |
| `cacheFallback` | bool | false | 远程失败时降级用上一次成功结果 |
| `label` | `it => 主文本` | 必填 | 候选主列 |
| `code` | `it => 编码` | `()=>''` | 参与编码前缀/精确匹配 |
| `sub` | `it => 辅助列` | `()=>''` | 候选右侧灰色列（规格/价格/ICD 编码等） |
| `py` | `it => 简码` | 自动按 GB2312 声母表推导 | 显式简码（如药品表 pinyin 字段） |
| `value` | `it => 输入框回填文本` | 同 label | 采纳后输入框显示内容 |
| `onPick(item, el, how)` | 函数 | — | 采纳回调；`how` = `enter/tab/click/unique-tab` |
| `tabTarget` | CSS 选择器 | — | Tab 唯一命中时跳转的下一输入框 |
| `minChars` | number | 1 | 触发联想的最小字符数 |
| `debounce` | ms | 200 | 输入防抖 |
| `max` | number | 200 | 候选上限（超出部分虚拟滚动） |
| `emptyHint` | string | '无匹配' | 空态提示文案 |

采纳后组件自动写入 `inputEl.dataset.acValue = code(item)`，业务代码读取该值即可拿到编码，无需解析显示文本。

## 2. 交互规格（对齐 IntelliJ IDEA）

- 输入 ≥1 字符弹出候选（debounce 200ms），边输入边联想。
- 匹配打分排序：编码精确 130 > 编码前缀 120 > 名称精确 110 > 简码前缀 100 > 简码包含 80 > 名称包含 60 > `*` 通配 40 > 子序列 30；命中片段 `<mark>` 高亮。
- 拼音首字母零依赖：运行时用 `TextDecoder('gbk')` 扫描 GB2312 一级字库，以 23 个段首定界字构建字→声母 Map（`aspl → 阿司匹林肠溶片`、`gxy → 高血压`、`nk → 内科`）。
- 键盘：`↑↓` 移动（默认选中第一项）、`Enter`/鼠标点击采纳、`Tab` 采纳且唯一命中时直接确认并跳 `tabTarget`（IDEA Tab 补全语义）、`Esc` 关闭。
- 长列表虚拟滚动：固定行高 34px、视口 280px，仅渲染窗口内节点。
- 空态可操作：无匹配时显示 `emptyHint` + 新建引导（药品/诊断场景）。

## 3. 本项目 5 处接入示例（app/web/app.js）

| 输入框 | 数据源 | 辅助列 | 采纳联动 |
| --- | --- | --- | --- |
| `#rx-drug` 处方药品 | `items=state.drugs(ACTIVE)` | 规格 · 价格 · 库存 · 抗菌级 | `dataset.drugId`；空白时自动填 `#rx-dosage`、`#rx-frequency`（defaultRoute/defaultFreq）；`tabTarget='#rx-dosage'` |
| `#sd-code` 诊断 | `items=state.icd` | `ICD编码 · 类别` | `addDiagnosis` 读 `dataset.acValue` |
| `#lab-search` 诊疗项目 | `items=state.labItems` | 价格 · 类别 | 勾选对应 checkbox 并清空输入 |
| `#reg-dept` 科室 | `items=state.depts` | 科室编码 | `code=String(id)`，onPick 触发 `loadSlots` |
| `#reg-patient-q` 患者 | `remote=/api/v1/patients?q=` + `cacheFallback` | `病历号 · 性别 · 年龄` | `value='mrn 姓名'`，选中后临时以 mrn 刷新下拉显示 |

药品示例（本地字典 + 联动 + Tab 跳转）：

```js
AutoComplete.attach($('#rx-drug'), {
  items: () => state.drugs.filter(d => d.status === 'ACTIVE'),
  label: d => d.name,
  code: d => d.code,
  sub: d => `${d.spec} · ${money(d.price)} · 库存${d.stock}`,
  tabTarget: '#rx-dosage',
  onPick: (d, el) => {
    el.dataset.drugId = d.id;
    if (!formVal('rx-dosage')) $('#rx-dosage').value = d.defaultRoute || '';
    if (!formVal('rx-frequency')) $('#rx-frequency').value = d.defaultFreq || '';
  },
});
```

患者示例（远程搜索 + 降级缓存）：

```js
AutoComplete.attach($('#reg-patient-q'), {
  remote: async q => (await api('GET', `/api/v1/patients?q=${encodeURIComponent(q)}`)).data,
  cacheFallback: true,
  label: p => p.name,
  code: p => p.mrn,
  sub: p => `${p.mrn} · ${p.gender} · ${p.age}岁`,
  value: p => `${p.mrn} ${p.name}`,
  onPick: (p, el) => { state.selectedPatient = p; },
});
```

## 4. 实测结论（浏览器第二轮复验）

`aspl/btlk/gxy/xdt/nk` 简码、编码前缀、`*` 通配、↑↓/Enter/Tab/Esc、药品联动、检查自动勾选均通过，控制台无 JS 错误；截图见 [docs/screenshots/autocomplete/](file:///d:/asr_chaoshanhua/asr_chaoshanhua_V01/_V01/wechar/clinic-his/docs/screenshots/autocomplete)。

> 患者候选选中后下拉显示（`P000053 陈**` 格式、无空态、无 JS 报错）已于 2026-11-20 浏览器复验通过。
