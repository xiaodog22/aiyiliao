/**
 * components/offline-bar —— 全局离线提示条（只读可见，提交类操作已暂停）
 *
 * 设计取舍：
 *   · 不做全屏错误页：已加载内容仍可浏览，老人不会因为一次断网被彻底挡在门外；
 *   · 不做"静默继续"：默认数据/演示数据必须显式标出来，否则用户会以为看到的是实时信息；
 *   · 写操作由 services/request.js 的 connectivity.ensureWritable() 统一拦截，
 *     本组件只负责"让用户知道现在为什么不能提交"，不重复做业务判断。
 */
const connectivity = require('../../services/connectivity.js')

Component({
  data: {
    show: false,
    title: '',
    detail: '',
    retrying: false
  },

  lifetimes: {
    attached() {
      this._unsub = connectivity.subscribe((s) => this._render(s))
    },
    detached() {
      if (this._unsub) this._unsub()
      this._unsub = null
    }
  },

  methods: {
    _render(s) {
      if (!s || (s.online && !s.degraded)) {
        this.setData({ show: false, retrying: false })
        return
      }
      const mock = s.source === 'mock'
      const deviceDown = s.source === 'network'
      const title = mock
        ? '演示数据 · 未连接院内服务'
        : (deviceDown ? '设备网络已断开 · 当前只读' : '院内服务未连接 · 当前只读')
      const detail = mock
        ? '仅供界面预览，预约、问诊、床位申请等提交操作已暂停'
        : '已加载内容可继续查看，可能不是最新；提交类操作已暂停'
      this.setData({ show: true, title, detail, retrying: false })
    },

    onRetry() {
      if (this.data.retrying) return
      this.setData({ retrying: true })
      connectivity.probe({ silent: true }).then((ok) => {
        if (ok) {
          this.setData({ show: false, retrying: false })
          return
        }
        this.setData({ retrying: false })
        if (typeof wx !== 'undefined' && wx.showToast) {
          wx.showToast({ title: '仍未连接，请稍后重试', icon: 'none' })
        }
      })
    }
  }
})
