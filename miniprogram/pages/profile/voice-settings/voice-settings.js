/**
 * pages/profile/voice-settings —— 音色管理
 * 设计稿：design-output/患者端/C-个人中心/11-音色管理.png（1391×3014，1rpx ≈ 1.8547px）
 *
 * 数据：**纯本地**（services/voice.js 本地版），无后端接口 —— 按本轮需求。
 *   · 音色目录 = services/voice.js 的 CATALOG（取自设计稿四个音色）
 *   · 选中音色 → storage `wb_voice`（speech 播报直接读）
 *   · 语速     → storage `wb_voice_rate`（0.8 / 1.0 / 1.2 三档，映射慢/标准/快）
 *   · 删除记录 → storage `wb_voice_hidden`
 *
 * 交互（设计稿 + 本轮需求合并）：
 *   ① 顶部蓝边卡 = 当前生效音色（设计稿原样），右侧「试听」
 *   ② 可选音色列表：图标 + 名称 + 描述 + 试听 +（自定义→删除 / 非当前→设为默认）+ 选中态
 *      · 点行      → 选中（选中态 + 「已选」chip），待「保存」生效
 *      · 设为默认  → 立刻生效（保留设计稿的即时语义）
 *      · 删除      → 仅自定义音色，二次确认
 *   ③ 语速调节（设计稿无，按需求增补）④ 保存（落盘音色 + 语速）
 *
 * 试听走 services/speech.js 的 TTS 合成固定示例句（契约 /api/v1/voice/tts）；
 * 语音服务不可用时如实提示，不伪造音频、不假装在播。
 */
const app = getApp()
const voice = require('../../../services/voice.js')
const speech = require('../../../services/speech.js')
const { errText } = require('../../../utils/err-text.js')
const icons = require('../../../utils/icons.js')

// 语速三档（在 speech 允许的 0.5~2.0 区间内取三档，1.0 为原速）
const RATES = [0.8, 1.0, 1.2]
const RATE_LABELS = ['慢', '标准', '快']
// 试听示例句：固定文本，避免把试听做成任意合成入口
const SAMPLE_TEXT = '你好，我是小安。有哪里不舒服，可以直接告诉我。'

Page({
  data: {
    theme: 'standard',
    icons,
    statusBarHeight: 20,
    navH: 64,

    rows: [],
    current: '',
    currentName: '',
    currentDesc: '',
    hiddenCount: 0,

    // 选中态：pending 为本次待保存的音色（空 = 无改动）
    pending: '',
    pendingName: '',

    playingId: '',
    engineHint: '',

    rateIndex: 1,
    ratePct: 50,
    rateMarks: RATE_LABELS,
    rateLabel: RATE_LABELS[1]
  },

  onLoad() {
    let sbh = 20
    try { sbh = (wx.getWindowInfo() || {}).statusBarHeight || 20 } catch (e) {}

    const idx = this._nearestRateIndex(speech.currentRate())
    this.setData({
      theme: app.globalData.theme || 'standard',
      statusBarHeight: sbh,
      navH: sbh + 44,
      rateIndex: idx,
      ratePct: idx * 50,
      rateLabel: RATE_LABELS[idx]
    })
    this._refresh()
    // 远端音色目录（契约 GET /api/v1/voice/voices）覆盖本地首屏；失败回落本地目录
    voice.catalogRemote().then((c) => {
      if (this._gone) return
      const pending = this.data.pending
      const okPending = c.rows.some((r) => r.id === pending) ? pending : ''
      const rows = c.rows.map((r) => ({
        id: r.id,
        name: r.name,
        desc: r.desc,
        custom: r.custom,
        on: r.id === c.current,
        sel: !!okPending && r.id === okPending
      }))
      this.setData({
        rows,
        current: c.current,
        currentName: c.currentName,
        currentDesc: c.currentDesc,
        hiddenCount: c.hiddenCount,
        pending: okPending
      })
    }).catch(() => {})
  },

  onShow() {
    // 从其它页返回时只同步主题（字体档可能在设置页被改）
    const t = app.globalData.theme || 'standard'
    if (t !== this.data.theme) this.setData({ theme: t })
  },

  onUnload() {
    this._gone = true
    speech.stopSpeak()
  },

  // ==================== 目录 / 选中态 ====================

  /** 重建列表（本地读取，同步完成，无需 loading / 错误态） */
  _refresh(extra) {
    const c = voice.catalog()
    const pending = (extra && extra.pending !== undefined) ? extra.pending : this.data.pending
    // 待保存的音色被删掉时清空选中态
    const okPending = c.rows.some((r) => r.id === pending) ? pending : ''
    const hitPending = c.rows.filter((r) => r.id === okPending)[0]

    const rows = c.rows.map((r) => ({
      id: r.id,
      name: r.name,
      desc: r.desc,
      custom: r.custom,
      // on = 当前生效；sel = 本次选中待保存。当前项不再重复标「已选」
      on: r.id === c.current,
      sel: !!okPending && r.id === okPending
    }))

    this.setData({
      rows,
      current: c.current,
      currentName: c.currentName,
      currentDesc: c.currentDesc,
      hiddenCount: c.hiddenCount,
      pending: okPending,
      pendingName: hitPending ? hitPending.name : ''
    })
  },

  /** 点行 = 选中（不落盘，等「保存」） */
  onPick(e) {
    const id = e.currentTarget.dataset.id || ''
    if (!id || id === this.data.current) {
      // 点当前生效项 = 取消待保存的改动
      if (this.data.pending) this._refresh({ pending: '' })
      return
    }
    if (id === this.data.pending) return
    this._refresh({ pending: id })
  },

  // ==================== 生效 / 保存 ====================

  /** 设为默认：设计稿的即时生效语义，保留 */
  onSetDefault(e) {
    const id = e.currentTarget.dataset.id || ''
    if (!id || id === this.data.current) return
    this._apply(id, '已设为默认音色')
  },

  /** 保存：把选中的音色 + 语速一起落本地 */
  onSave() {
    const rate = RATES[this.data.rateIndex] || 1
    const id = this.data.pending || this.data.current
    if (!id) {
      wx.showToast({ title: '暂无可选音色', icon: 'none' })
      return
    }
    this._apply(id, '设置已保存')
  },

  _apply(voiceId, tip) {
    speech.stopSpeak()
    this.setData({ playingId: '', engineHint: '' })
    voice.save({ voiceId, rate: RATES[this.data.rateIndex] })
      .then((res) => {
        this._refresh({ pending: '' })
        // 本地已生效；云端同步失败时如实说清"本机仍生效"，不报"保存失败"（那不是事实）
        if (res && res.synced === false) {
          wx.showToast({ title: '已在本机生效，云端同步失败', icon: 'none', duration: 2500 })
          this.setData({ engineHint: '音色偏好已在本机生效，但未能同步到账号（换设备后可能不同）' })
          return
        }
        wx.showToast({ title: tip, icon: 'none' })
      })
      .catch((err) => {
        this.setData({ engineHint: errText(err, '保存失败，请稍后重试') })
      })
  },

  // ==================== 试听 ====================

  onPreview(e) {
    const id = e.currentTarget.dataset.id || ''
    if (!id || this.data.playingId) return
    this.setData({ playingId: id, engineHint: '' })
    speech.stopSpeak()
    const opts = {
      // 试听即预览新语速：用户改完语速能立刻听出差别
      rate: RATES[this.data.rateIndex],
      onEnd: () => { if (this.data.playingId === id) this.setData({ playingId: '' }) },
      onError: () => {
        this.setData({
          playingId: '',
          engineHint: '语音服务暂不可用，暂时无法试听（不影响音色与语速设置）'
        })
      },
      // 占位音质：仍然播放，但必须告诉用户"现在听到的不是正式音色"（AI_CONTEXT #7）
      onDegraded: () => {
        this.setData({ engineHint: '当前为占位音质，正式音色上线后自动切换' })
      }
    }
    // 先走契约试听通道（固定示例文本）；失败再回落主 TTS 接口，保证"点了有声音"
    voice.preview(id, opts).then((played) => {
      if (played || this.data.playingId !== id) return
      speech.speak(SAMPLE_TEXT, Object.assign({ voice: id }, opts))
    })
  },

  // ==================== 删除 / 恢复 ====================

  onRemove(e) {
    const id = e.currentTarget.dataset.id || ''
    if (!id) return
    const hit = this.data.rows.filter((r) => r.id === id)[0]
    wx.showModal({
      title: '删除音色',
      content: '删除后不可恢复，确定删除「' + ((hit && hit.name) || '该音色') + '」吗？',
      confirmText: '删除',
      confirmColor: '#F53F3F',
      success: (res) => {
        if (!res.confirm) return
        if (this.data.playingId === id) {
          speech.stopSpeak()
          this.setData({ playingId: '' })
        }
        voice.remove(id)
          .then(() => {
            this._refresh({ pending: '' })
            wx.showToast({ title: '已删除', icon: 'none' })
          })
          .catch((err) => {
            this.setData({ engineHint: errText(err, '删除失败，请稍后重试') })
          })
      }
    })
  },

  onRestore() {
    if (!this.data.hiddenCount) return
    voice.restore()
      .then(() => {
        this._refresh({ pending: '' })
        wx.showToast({ title: '已恢复默认音色列表', icon: 'none' })
      })
      .catch(() => {})
  },

  // ==================== 语速 ====================

  onSpeedTouch(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])
    if (!t) return
    wx.createSelectorQuery().in(this).select('.vs-speed-track').boundingClientRect((rect) => {
      if (!rect || !rect.width) return
      const ratio = Math.max(0, Math.min(1, (t.clientX - rect.left) / rect.width))
      const idx = Math.round(ratio * 2)
      if (idx === this.data.rateIndex) return
      this.setData({ rateIndex: idx, ratePct: idx * 50, rateLabel: RATE_LABELS[idx] })
    }).exec()
  },

  /** 滑块容器自带 catchtouchmove，避免拖动时页面跟着滚 */
  noop() {},

  // ==================== 导航 ====================

  onBack() {
    if (getCurrentPages().length > 1) { wx.navigateBack(); return }
    wx.reLaunch({ url: '/pages/profile/profile' })
  },

  // ==================== 工具 ====================

  /** 当前 rate → 最近档位（异常值回落「标准」） */
  _nearestRateIndex(rate) {
    const v = Number(rate)
    if (!isFinite(v)) return 1
    let best = 1
    let gap = Infinity
    RATES.forEach((r, i) => {
      const d = Math.abs(r - v)
      if (d < gap) { gap = d; best = i }
    })
    return best
  }
})
