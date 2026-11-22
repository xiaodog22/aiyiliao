/* =====================================================================
 * AutoComplete — IDEA 风格输入自动补全通用组件（零依赖）
 * ---------------------------------------------------------------------
 * 匹配策略：编码前缀 > 拼音首字母前缀 > 拼音首字母包含 > 名称包含 > * 通配
 * 交互：输入≥1字符联想（debounce 默认 200ms）；↑↓ 移动、默认选中第一项、
 *       Enter/鼠标点击采纳、Tab 采纳并跳下一输入框、Esc 关闭。
 * 候选层：主文本 + 右侧灰色辅助列（规格/价格/编码等，由 sub 配置）。
 * 长列表虚拟滚动（固定行高窗口渲染）；远程失败降级本地缓存；空态可操作。
 *
 * 用法示例：
 *   AutoComplete.attach(inputEl, {
 *     items: () => state.drugs,                 // 本地字典（函数或数组）
 *     label: d => d.name,                       // 主文本
 *     code:  d => d.code,                       // 编码（前缀匹配）
 *     sub:   d => `${d.spec} · ${money(d.price)}`, // 右侧辅助列
 *     onPick: (d, el) => { el.dataset.drugId = d.id; },
 *     tabTarget: '#rx-dosage',                  // Tab 唯一命中时跳转的目标
 *   });
 *   远程 + 降级缓存：
 *   AutoComplete.attach(el, {
 *     remote: async q => api('GET', `/api/v1/patients?q=${encodeURIComponent(q)}`),
 *     cacheFallback: true,                      // 远程失败时用上一次成功结果
 *     label: p => p.name, code: p => p.mrn,
 *   });
 * ===================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------ 拼音首字母引擎 */
  let _initialMap = null;
  function initialMap() {
    if (_initialMap) return _initialMap;
    const map = new Map();
    try {
      const dec = new TextDecoder('gbk');
      // GB2312 一级字库（0xB0A1-0xD7F9）按拼音排序，段首字定界声母
      const bounds = [
        ['啊', 'A'], ['芭', 'B'], ['擦', 'C'], ['搭', 'D'], ['蛾', 'E'], ['发', 'F'],
        ['噶', 'G'], ['哈', 'H'], ['击', 'J'], ['喀', 'K'], ['垃', 'L'], ['妈', 'M'],
        ['拿', 'N'], ['哦', 'O'], ['啪', 'P'], ['期', 'Q'], ['然', 'R'], ['撒', 'S'],
        ['塌', 'T'], ['挖', 'W'], ['昔', 'X'], ['压', 'Y'], ['匝', 'Z'],
      ];
      let cur = '';
      let bi = 0;
      for (let hi = 0xB0; hi <= 0xD7; hi++) {
        for (let lo = (hi === 0xB0 ? 0xA1 : 0x81); lo <= 0xFE; lo++) {
          const ch = dec.decode(new Uint8Array([hi, lo]));
          if (!ch || ch.length !== 1 || ch === '\uFFFD') continue;
          if (bi < bounds.length && ch === bounds[bi][0]) { cur = bounds[bi][1]; bi++; }
          if (cur) map.set(ch, cur);
        }
      }
    } catch (err) { /* 不支持 gbk 时退化为仅字母匹配 */ }
    _initialMap = map;
    return map;
  }

  function initialsOf(text) {
    const map = initialMap();
    let out = '';
    for (const ch of String(text || '')) {
      if (/[a-zA-Z]/.test(ch)) out += ch.toLowerCase();
      else if (map.has(ch)) out += map.get(ch).toLowerCase();
    }
    return out;
  }

  /* ------------------------------------------------ 匹配与打分 */
  const NO_MATCH = -1;
  function scoreMatch(q, label, code, py) {
    const needle = q.toLowerCase().replace(/\s+/g, '');
    if (!needle) return { score: 0, hl: null };
    if (needle.includes('*')) {
      // 通配：* 视为任意片段，段间按顺序匹配（对名称或简码）
      const parts = needle.split('*').filter(Boolean);
      if (!parts.length) return { score: 0, hl: null };
      const hay = (label + '|' + (code || '') + '|' + py).toLowerCase();
      let pos = 0;
      for (const p of parts) {
        const at = hay.indexOf(p, pos);
        if (at < 0) return null;
        pos = at + p.length;
      }
      return { score: 40, hl: null };
    }
    const lowLabel = label.toLowerCase();
    if (code && code.toLowerCase() === needle) return { score: 130, hl: findHl(label, needle) };
    if (code && code.toLowerCase().startsWith(needle)) return { score: 120, hl: null };
    if (lowLabel === needle) return { score: 110, hl: { start: 0, end: label.length } };
    if (py && py.startsWith(needle)) return { score: 100, hl: null };
    if (py && py.includes(needle)) return { score: 80, hl: null };
    if (lowLabel.includes(needle)) return { score: 60, hl: findHl(label, needle) };
    // 逐字穿插（如 a* 前缀式联想：a s p → 阿司匹林 简码 aspl 的子序列）
    if (py) {
      let i = 0;
      for (const ch of py) if (ch === needle[i]) i++;
      if (i === needle.length && needle.length >= 2) return { score: 30, hl: null };
    }
    return null;
  }
  function findHl(label, needle) {
    const at = label.toLowerCase().indexOf(needle);
    return at < 0 ? null : { start: at, end: at + needle.length };
  }

  /* ------------------------------------------------ 组件 */
  const ITEM_H = 34;      // 虚拟滚动固定行高（与 CSS .ac-item 一致）
  const VIEW_H = 280;     // 候选层最大高度

  class AutoComplete {
    constructor(input, opts) {
      this.input = input;
      this.opts = Object.assign({
        minChars: 1,
        debounce: 200,
        max: 200,
        cacheFallback: true,
        label: it => String(it.name || it.label || ''),
        code: it => String(it.code || it.value || ''),
        py: null,               // 自定义简码；缺省按 label 自动计算
        sub: () => '',
        value: null,            // 采纳后写入输入框的文本；缺省 label
        items: null,            // 本地数据源：数组或 ()=>数组
        remote: null,           // 远程搜索：async q => items[]
        onPick: null,
        tabTarget: null,        // 唯一命中 Tab 跳转目标选择器
        emptyHint: '无匹配结果',
      }, opts || {});
      this._cache = [];         // 最近一次成功数据（远程降级）
      this._pyCache = new Map();
      this._timer = 0;
      this._seq = 0;
      this._items = [];
      this._sel = -1;
      this._open = false;
      this._build();
      this._bind();
    }

    _pyOf(item) {
      const key = this.opts.label(item);
      if (this._pyCache.has(key)) return this._pyCache.get(key);
      const py = this.opts.py ? String(this.opts.py(item) || '').toLowerCase() : initialsOf(key);
      this._pyCache.set(key, py);
      return py;
    }

    _build() {
      const wrap = document.createElement('span');
      wrap.className = 'ac-wrap';
      this.input.parentNode.insertBefore(wrap, this.input);
      wrap.appendChild(this.input);
      const list = document.createElement('div');
      list.className = 'ac-pop hidden';
      list.innerHTML = '<div class="ac-spacer"></div>';
      wrap.appendChild(list);
      this.pop = list;
      this.spacer = list.querySelector('.ac-spacer');
      list.addEventListener('scroll', () => this._render());
    }

    _bind() {
      this.input.autocomplete = 'off';
      this.input.classList.add('ac-input');
      this.input.addEventListener('input', () => {
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this._query(this.input.value), this.opts.debounce);
      });
      this.input.addEventListener('focus', () => {
        if (this.input.value.trim().length >= this.opts.minChars && this._items.length) this._show();
      });
      this.input.addEventListener('keydown', ev => this._onKey(ev));
      this._docHandler = ev => {
        if (!this.pop.contains(ev.target) && ev.target !== this.input) this._hide();
      };
      document.addEventListener('mousedown', this._docHandler);
    }

    async _query(raw) {
      const q = String(raw || '').trim();
      const seq = ++this._seq;
      if (q.length < this.opts.minChars) { this._hide(); return; }
      let pool = [];
      if (this.opts.remote) {
        try {
          pool = await this.opts.remote(q) || [];
          this._cache = pool;                    // 成功即更新降级缓存
        } catch (err) {
          if (this.opts.cacheFallback) pool = this._cache;  // 失败降级本地缓存
          else { this._hide(); return; }
        }
      } else {
        const src = typeof this.opts.items === 'function' ? this.opts.items() : this.opts.items;
        pool = src || [];
        // 远程兜底检索失败同理：本地源失败概率低，直接缓存
        this._cache = pool;
      }
      if (seq !== this._seq) return;            // 丢弃过期响应
      // 远程数据源：服务端已按原始字段（姓名/病历号/手机掩码/哈希）检索并排好序，
      // 前端不再按「脱敏后的展示名」二次打分 —— 否则输入全名（陈楷楠）会被掩码
      // （陈**）过滤成空列表，表现为「输入关键词没有任何候选」。
      if (this.opts.remote) {
        this._items = pool.slice(0, this.opts.max).map(it => ({
          it, label: this.opts.label(it), m: { score: 0, hl: null },
        }));
        this._sel = this._items.length ? 0 : -1;
        this._show();
        return;
      }
      const scored = [];
      for (const it of pool) {
        const label = this.opts.label(it);
        const m = scoreMatch(q, label, this.opts.code(it), this._pyOf(it));
        if (m) scored.push({ it, label, m, sort: -m.score });
      }
      scored.sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label, 'zh'));
      this._items = scored.slice(0, this.opts.max);
      this._sel = this._items.length ? 0 : -1;
      this._show();
    }

    _show() {
      this._open = true;
      this.pop.classList.remove('hidden');
      this._render();
    }

    _hide() {
      this._open = false;
      this.pop.classList.add('hidden');
    }

    /* 虚拟滚动：仅渲染可视窗口 + 缓冲 */
    _render() {
      if (!this._open) return;
      const n = this._items.length;
      if (!n) {
        this.pop.innerHTML = `<div class="ac-empty">${esc(this.opts.emptyHint)}
          <button type="button" class="ac-clear">清空关键词</button></div>`;
        const btn = this.pop.querySelector('.ac-clear');
        if (btn) btn.onclick = () => { this.input.value = ''; this.input.focus(); this._query(this.input.value); };
        return;
      }
      const total = n * ITEM_H;
      this.pop.style.maxHeight = Math.min(VIEW_H, total + 8) + 'px';
      const scrollTop = this.pop.scrollTop;
      const viewH = Math.min(VIEW_H, total);
      const from = Math.max(0, Math.floor(scrollTop / ITEM_H) - 4);
      const to = Math.min(n, Math.ceil((scrollTop + viewH) / ITEM_H) + 4);
      const rows = [];
      for (let i = from; i < to; i++) {
        const { it, label, m } = this._items[i];
        const sub = this.opts.sub(it);
        const hl = m.hl ? highlight(label, m.hl.start, m.hl.end) : esc(label);
        rows.push(`<div class="ac-item${i === this._sel ? ' sel' : ''}" data-i="${i}"
          style="top:${i * ITEM_H}px">
          <span class="ac-main">${hl}</span><span class="ac-sub">${esc(sub)}</span></div>`);
      }
      this.pop.innerHTML = `<div class="ac-spacer" style="height:${total}px">${rows.join('')}</div>`;
      this.spacer = this.pop.querySelector('.ac-spacer');
      this.pop.querySelectorAll('.ac-item').forEach(el => {
        el.onmousedown = ev => { ev.preventDefault(); this._pick(Number(el.dataset.i), 'mouse'); };
        el.onmousemove = () => { if (this._sel !== Number(el.dataset.i)) { this._sel = Number(el.dataset.i); this._repaintSel(); } };
      });
      this._ensureVisible();
    }

    _repaintSel() {
      this.pop.querySelectorAll('.ac-item').forEach(el => {
        el.classList.toggle('sel', Number(el.dataset.i) === this._sel);
      });
      this._ensureVisible();
    }

    _ensureVisible() {
      if (this._sel < 0) return;
      const top = this._sel * ITEM_H;
      const bottom = top + ITEM_H;
      if (top < this.pop.scrollTop) this.pop.scrollTop = top;
      else if (bottom > this.pop.scrollTop + this.pop.clientHeight) this.pop.scrollTop = bottom - this.pop.clientHeight;
    }

    _onKey(ev) {
      if (!this._open) {
        if (ev.key === 'ArrowDown') { this._query(this.input.value); ev.preventDefault(); }
        return;
      }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); this._sel = Math.min(this._sel + 1, this._items.length - 1); this._repaintSel(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); this._sel = Math.max(this._sel - 1, 0); this._repaintSel(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); this._hide(); }
      else if (ev.key === 'Enter') {
        if (this._sel >= 0 && this._items.length) { ev.preventDefault(); this._pick(this._sel, 'enter'); }
      } else if (ev.key === 'Tab') {
        if (this._sel >= 0 && this._items.length) {
          ev.preventDefault();
          const unique = this._items.length === 1;
          this._pick(this._sel, 'tab');
          if (unique && this.opts.tabTarget) {
            const next = document.querySelector(this.opts.tabTarget);
            if (next) next.focus();
          }
        }
      }
    }

    _pick(i, how) {
      const entry = this._items[i];
      if (!entry) return;
      const it = entry.it;
      const text = this.opts.value ? this.opts.value(it) : this.opts.label(it);
      this.input.value = text;
      this.input.dataset.acValue = this.opts.code(it);
      this._hide();
      if (this.opts.onPick) this.opts.onPick(it, this.input, how);
      this.input.dispatchEvent(new CustomEvent('ac-pick', { detail: { item: it, how } }));
    }

    destroy() {
      document.removeEventListener('mousedown', this._docHandler);
      this.pop.remove();
      const wrap = this.input.parentNode;
      if (wrap && wrap.classList.contains('ac-wrap')) {
        wrap.parentNode.insertBefore(this.input, wrap);
        wrap.remove();
      }
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function highlight(text, start, end) {
    return esc(text.slice(0, start)) + '<mark>' + esc(text.slice(start, end)) + '</mark>' + esc(text.slice(end));
  }

  global.AutoComplete = { attach: (input, opts) => new AutoComplete(input, opts), initialsOf };
})(window);
