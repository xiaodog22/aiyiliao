/**
 * custom-tab-bar/index.js —— 自绘 TabBar
 * 原生 tabBar 无法按主题动态切换项数：
 *   · standard  → 4 项：首页 / AI问诊 / AI养生 / 我的
 *   · large/xlarge（适老化）→ 3 项：首页 / 就医 / 我的
 * 每个 tab 页面 onShow 时调用 this.getTabBar().setData({ selected: N }) 高亮当前项。
 */
const app = getApp()

// 标准模式 4 项配置
const TABS_STANDARD = [
  { pagePath: '/pages/home/home',       text: '首页',   icon: '/assets/icons/home_gray.png',  activeIcon: '/assets/icons/home.png' },
  { pagePath: '/pages/consultation/consultation', text: 'AI问诊', icon: '/assets/icons/chat_gray.png', activeIcon: '/assets/icons/chat.png' },
  { pagePath: '/pages/appointment/appointment', text: '预约挂号', icon: '/assets/icons/calendar_gray.png', activeIcon: '/assets/icons/calendar.png' },
  { pagePath: '/pages/profile/profile', text: '我的',   icon: '/assets/icons/user_gray.png',  activeIcon: '/assets/icons/user.png' }
]

// 适老模式 3 项配置：去掉 AI养生，问诊入口简化为"就医"
const TABS_ELDER = [
  { pagePath: '/pages/home/home',       text: '首页', icon: '/assets/icons/home_gray.png',  activeIcon: '/assets/icons/home.png' },
  { pagePath: '/pages/consultation/consultation', text: '就医', icon: '/assets/icons/chat_gray.png', activeIcon: '/assets/icons/chat.png' },
  { pagePath: '/pages/profile/profile', text: '我的', icon: '/assets/icons/user_gray.png',  activeIcon: '/assets/icons/user.png' }
]

Component({
  data: {
    selected: 0,
    theme: 'standard',
    list: TABS_STANDARD
  },

  lifetimes: {
    attached() {
      this._syncTheme()
    }
  },

  methods: {
    // 根据全局主题刷新 tab 列表（切换字号模式后由设置页触发）
    refresh() {
      this._syncTheme()
    },

    _syncTheme() {
      const theme = app.globalData.theme || 'standard'
      const isElder = theme === 'large' || theme === 'xlarge'
      const list = isElder ? TABS_ELDER : TABS_STANDARD
      this.setData({ theme, list })
    },

    // 页面 onShow 时调用：按页面路径高亮，自动适配标准/适老两种项数
    // 用法：if (typeof this.getTabBar === 'function' && this.getTabBar()) {
    //        this.getTabBar().selectByPath('/pages/home/home')
    //      }
    selectByPath(pagePath) {
      // 先确保列表与当前主题同步（设置页切主题后 tab 页 onShow 会走到这里）
      this._syncTheme()
      const idx = this.data.list.findIndex(t => t.pagePath === pagePath)
      if (idx >= 0 && idx !== this.data.selected) {
        this.setData({ selected: idx })
      }
    },

    // 点击 tab：切换页面
    onTap(e) {
      const idx = e.currentTarget.dataset.index
      const item = this.data.list[idx]
      if (!item) return
      if (idx === this.data.selected) return
      wx.switchTab({ url: item.pagePath })
    }
  }
})
