/**
 * components/skeleton —— 通用骨架屏组件（加载占位）
 * 用法：页面数据加载期间 loading=true 显示骨架，数据到达后 loading=false 隐藏。
 * 属性：
 *   loading  Boolean  是否显示骨架（默认 true）
 *   type     String   list（列表行）| stats（统计数字块）| card（大卡片，默认）
 *   rows     Number   内容条数（list/card 用，默认 4）
 * 动画仅用 opacity 脉冲（符合项目「动画只动 opacity」规范，真机不闪屏）。
 */
Component({
  properties: {
    loading: { type: Boolean, value: true },
    type: { type: String, value: 'card' },
    rows: { type: Number, value: 4 }
  },

  data: {
    list: [],
    stats: [0, 1, 2]
  },

  lifetimes: {
    attached() {
      this._build()
    }
  },

  observers: {
    'rows, type'() {
      this._build()
    }
  },

  methods: {
    _build() {
      const n = Math.max(1, Math.min(20, Number(this.data.rows) || 4))
      const list = []
      for (let i = 0; i < n; i++) list.push(i)
      this.setData({ list })
    }
  }
})
