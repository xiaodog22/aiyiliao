/**
 * components/submission-actions —— 提交完成后的「通过 / 去评定项目」入口
 *
 * 展示条件、状态校验、幂等一律消费 utils/submission-actions.js（唯一真源），组件只做
 * 渲染、事件与跳转；不写业务数据、不落库、不直连后端。
 *
 * 【M1 回滚契约 · 2026-11-10】不扩 4 状态枚举，只用本地 passPending 标记「已发 pass、待宿主裁决」：
 *   - onPass 成功后 passed=true / passPending=true；待裁决期间任何无关属性刷新都不回退 passed、
 *     不重发 pass（旧版 _sync 只认 properties.status，会把乐观态刷回 → 重复落库）。
 *   - 宿主裁决只有两种显式信号：① 下发 status=PASSED → 清 pending、进终态；
 *     ② 审批失败 → selectComponent 拿到实例调 rollbackPass()，并把 status 改回 SUBMITTED →
 *     回退、允许重试。终态（status=PASSED）下 rollbackPass() 无效。
 *   - ⚠️ 宿主**必须给出裁决，且须自带请求超时兜底**（超时按失败调 rollbackPass）。
 *     否则组件会一直停在「已通过 / 待裁决」态。组件不内置定时器：超时属业务侧责任，
 *     内置会引入 wx 计时依赖与隐式状态，反而破坏纯渲染定位。
 *
 * 【G2 路径契约 · 2026-11-10】assessPath 由宿主注入**完整站内路径**（自带所需 query，
 *   含 submissionId）；组件只 navigateTo、不拼接 / 不改写 / 不校验格式，非法路径走 fail 中文提示。
 *   submissionId 仅经 pass 事件供宿主落库。是否改为组件拼接（需 encodeURIComponent）留评审会。
 *
 * 宿主接线（仓库当前没有「提交/评定」页面，故不预设路由，由调用方注入）：
 *   <submission-actions id="sa" status="{{submission.status}}" submission-id="{{submission.id}}"
 *     submitting="{{submitting}}" assess-path="{{assessPath}}" bind:pass="onMarkPassed" />
 *   onMarkPassed(e) → 走 services/ 审批契约落库；成功 setData({ status: 'PASSED' })，
 *   失败 setData({ status: 'SUBMITTED' }) 且 this.selectComponent('#sa').rollbackPass()。
 *
 * 属性：status(DRAFT/SUBMITTING/SUBMITTED/PASSED) / submissionId / submitting / assessPath / disabled
 * 事件：pass { submissionId, status, passedAt }（仅首次通过时触发一次）
 * 方法：rollbackPass()（显式失败回滚，见 M1 契约）
 */
'use strict'

const {
  canShowActions, markPassed, assessTarget, REASON, STATUS
} = require('../../utils/submission-actions.js')

// 本地校验提示（非后端错误，故不走 err-text.js）；两个 handler 共用一套中文确定性文案
const MSG = Object.freeze({
  NOT_READY: '提交完成后才可操作',
  ASSESS_NOT_READY: '提交完成后才可评定',
  NO_TARGET: '评定入口未配置',
  NAV_FAIL: '暂无法打开评定页面'
})

Component({
  properties: {
    status: { type: String, value: STATUS.DRAFT },
    submissionId: { type: String, value: '' },
    submitting: { type: Boolean, value: false },
    assessPath: { type: String, value: '' },
    disabled: { type: Boolean, value: false }
  },

  data: {
    showActions: false,
    passed: false,
    locked: false,
    passPending: false, // M1：已发 pass、待宿主裁决；期间 passed 单调，仅显式回滚才复位
    navigating: false   // 导航在途锁：连点不叠加页面栈（complete 时释放）
  },

  observers: {
    'status, submissionId, submitting, assessPath, disabled': function () {
      this._sync()
    }
  },

  lifetimes: {
    attached() { this._sync() }
  },

  methods: {
    /** properties → 状态机输入；仅在完成态时才让本地乐观通过态覆盖宿主旧 status（撤回态不覆盖） */
    _state() {
      const d = this.data
      const usable = d.status === STATUS.SUBMITTED || d.status === STATUS.PASSED
      return {
        status: usable && d.passed ? STATUS.PASSED : d.status,
        submissionId: d.submissionId,
        submitting: d.submitting,
        assessPath: d.assessPath
      }
    },

    /** 唯一真源：展示条件与 passed 同取 _state()；passPending 期间 passed 单调，仅显式回滚才复位 */
    _sync() {
      const d = this.data
      const confirmed = d.status === STATUS.PASSED
      const revoked = d.status === STATUS.DRAFT || d.status === STATUS.SUBMITTING
      this.setData({
        showActions: canShowActions(this._state()),
        passed: confirmed || (!!d.passed && !revoked),
        locked: !!d.submitting || !!d.disabled,
        passPending: !!d.passPending && !confirmed && !revoked
      })
    },

    /** 通过：仅提交完成后可点；重复触发不重复通知、不改变状态 */
    onPass() {
      if (this.data.locked) return
      const r = markPassed(this._state())
      if (!r.ok) {
        wx.showToast({ title: MSG.NOT_READY, icon: 'none' })
        return
      }
      if (!r.changed) return
      this.setData({ passed: true, passPending: true })
      this.triggerEvent('pass', {
        submissionId: r.state.submissionId,
        status: r.state.status,
        passedAt: r.state.passedAt
      })
    },

    /**
     * 显式失败回滚（M1 契约）：只在「已发 pass、宿主裁决为失败」时有效；宿主同时把 status
     * 改回 SUBMITTED。无关属性刷新不得调用本方法。终态 / 无 pending 时返回 false 且无副作用。
     * @returns {boolean}
     */
    rollbackPass() {
      if (!this.data.passPending) return false
      this.setData({ passed: false, passPending: false })
      this._sync()
      return true
    },

    /** 去评定项目：仅提交完成后可进入；目标由 assessPath 注入，不伪造路由 */
    onAssess() {
      if (this.data.locked || this.data.navigating) return
      const r = assessTarget(this._state())
      if (!r.ok) {
        // 本地校验提示（非后端错误，故不走 err-text.js），中文确定性文案，不直出 err.message
        wx.showToast({
          title: r.reason === REASON.NO_TARGET ? MSG.NO_TARGET : MSG.ASSESS_NOT_READY,
          icon: 'none'
        })
        return
      }
      this.setData({ navigating: true })
      try {
        wx.navigateTo({
          url: r.target,
          fail: () => wx.showToast({ title: MSG.NAV_FAIL, icon: 'none' }),
          complete: () => this.setData({ navigating: false })
        })
      } catch (e) {
        // 同步抛错（如非法 url）不会走 fail / complete，必须在此释放锁，
        // 否则之后所有点击都被 navigating 吞掉。保留控制台线索，不静默吞错。
        this.setData({ navigating: false })
        wx.showToast({ title: MSG.NAV_FAIL, icon: 'none' })
        console.warn('[submission-actions] navigateTo 同步异常：' + (e && e.message))
      }
    }
  }
})
