/**
 * components/doctor-tab-bar —— 医生端底部导航（问诊 / 消息 / 我的）
 *
 * 2026-11-20 医生端收缩：挂号队列（原「患者」）、床位、账号安全已迁 HIS / 下线，
 * 医生端只保留线上问诊能力，导航随之从 4 项收敛为 3 项。
 *
 * ⚠️ 为什么是自绘组件而不是原生 tabBar：
 *   1) app.json 的 tabBar.list 是**全局**的（患者端 4 项），原生 tabBar 无法按角色切换项名与项数；
 *   2) 医生端这 3 项也**不是真实 tab 页**，switchTab 跳不过去（会报 "can not switch to no-tabBar page"）。
 *   因此做成「页面级固定组件」：视觉与 custom-tab-bar 完全一致，跳转用 redirectTo（不叠栈）。
 *
 * 用法（医生端页面里）：
 *   <doctor-tabbar current="workbench" unread="{{unreadCount > 0}}" />
 *   current 取值：workbench / messages / me
 */
const ITEMS = [
  {
    key: 'workbench',
    text: '问诊',
    icon: 'layoutGridGray',
    activeIcon: 'layoutGrid',
    path: '/pages/doctor/workbench/workbench'
  },
  {
    // 医生端消息中心（2026-10-24 上线 pages/doctor/messages；患者申请/医生回复消息都在此）
    key: 'messages',
    text: '消息',
    icon: 'bellGray',
    activeIcon: 'bell',
    path: '/pages/doctor/messages/messages'
  },
  {
    key: 'me',
    text: '我的',
    icon: 'userGray',
    activeIcon: 'user',
    path: '/pages/doctor/personal/personal'
  }
]

const icons = require('../../utils/icons.js')

Component({
  properties: {
    /** 当前高亮项：workbench / patients / messages / me */
    current: { type: String, value: 'workbench' },
    /** 消息是否有未读（决定角标红点） */
    unread: { type: Boolean, value: false }
  },

  data: {
    list: ITEMS.map((it) => Object.assign({}, it, {
      iconUrl: icons[it.icon] || '',
      activeIconUrl: icons[it.activeIcon] || ''
    }))
  },

  methods: {
    onTap(e) {
      const key = e.currentTarget.dataset.key
      const item = ITEMS.filter((t) => t.key === key)[0]
      if (!item || key === this.data.current) return

      // 暂无页面：如实提示，不跳空白页
      if (!item.path) {
        wx.showToast({ title: item.text + '功能暂未开放', icon: 'none' })
        return
      }

      // redirectTo：底部导航语义上是「平级切换」，用 redirectTo 保持页面栈深度恒定；
      // 目标页若恰好是当前页（current 传错）也已被上面的 key 判断挡掉。
      wx.redirectTo({
        url: item.path,
        fail: () => {
          // 目标页已是栈底等极少数场景：退回 reLaunch，保证导航不会「点了没反应」
          wx.reLaunch({ url: item.path })
        }
      })
    }
  }
})
