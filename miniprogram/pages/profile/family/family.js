/**
 * pages/profile/family —— 家庭成员管理（我的 → 家庭成员）
 *
 * 版式（设计稿 design-output/患者端/C-个人中心/08-家庭成员.png）：
 *   顶部通栏浅蓝渐变带 + 半透明提示面板 → 成员白卡（头像 / 姓名 / 关系徽章 / 年龄段·授权态）
 *   → 卡内通栏分隔线 + 左右裸文字操作 → 贴底「添加家庭成员」描边胶囊 + 授权说明
 *
 * 数据源：GET /api/v1/family-members（FamilyMember[]）
 *   displayName / relation / proxyStatus（NONE|PENDING|GRANTED|REVOKED）/ ageBand? / phoneMasked? / avatarUrl?
 * 写操作：添加 POST（契约 FamilyMemberCreate：displayName+relation 必填，phone? 可选；幂等键由服务层生成）
 *         移除 DELETE /{id}
 *   ⚠️ 契约 additionalProperties:false —— 不夹带 idCard 等契约外字段（会 400）；
 *      身份证号也不在本页采集，成员身份由对方授权时核验（最小必要原则）。
 * 降级：加载中骨架屏；开发档（MOCK_FALLBACK）后端不可用 → 演示数据；上线档 → 错误态 + 重试。
 */
const app = getApp()
const icons = require('../../../utils/icons.js')
const userService = require('../../../services/user.js')
const { withFallback } = require('../../../services/request.js')
const { errText } = require('../../../utils/err-text.js')

/** proxyStatus 契约枚举 → 文案（设计稿写「已授权」，不写成「已授权代管」） */
const PROXY_TEXT = {
  NONE: '未授权',
  PENDING: '授权待确认',
  GRANTED: '已授权',
  REVOKED: '授权已撤销'
}

/**
 * relation 标签 → 展示文案。
 * 契约定义为自由字符串（前端枚举下发）：本端新增用中文，历史/联调数据可能是英文枚举
 * → 已知值统一转中文，未知值原样透传。
 */
const RELATION_TEXT = {
  SELF: '本人',
  SPOUSE: '配偶',
  FATHER: '父亲',
  MOTHER: '母亲',
  PARENT: '父母',
  CHILD: '子女',
  SON: '儿子',
  DAUGHTER: '女儿',
  OTHER: '其他'
}

/** 可添加的关系（设计稿徽章出现「父亲/母亲」，补齐常用项；契约 relation 为自由字符串） */
const RELATIONS = ['父亲', '母亲', '配偶', '子女', '其他']

const EMPTY_FORM = { name: '', relation: '', phone: '' }

/** 契约成员 → 页面字段（未返回字段留空不显示） */
function normalize(list) {
  return (Array.isArray(list) ? list : []).map((m) => {
    const rawRelation = String(m.relation || '')
    const proxyStatus = String(m.proxyStatus || '').toUpperCase()
    return {
      id: m.id || '',
      name: m.displayName || '',
      relation: RELATION_TEXT[rawRelation.toUpperCase()] || rawRelation,
      // 设计稿副行是「年龄段 · 授权态」；年龄段缺失时退到脱敏手机号（都是后端真实字段，不编造）
      metaText: [m.ageBand || m.phoneMasked || '', PROXY_TEXT[proxyStatus] || ''].filter(Boolean).join(' · '),
      proxyGranted: proxyStatus === 'GRANTED',
      avatarUrl: m.avatarUrl || '',
      avatarErr: false
    }
  })
}

/** 演示兜底：mock FAMILY → 契约同形（仅开发档可达） */
function mockMembers() {
  return ((app && app.MOCK && app.MOCK.FAMILY) || []).map((m) => ({
    id: m.id,
    displayName: m.name,
    relation: m.relation,
    ageBand: m.age == null || m.age === '' ? '' : String(m.age) + ' 岁',
    proxyStatus: m.relation === '本人' ? 'NONE' : 'GRANTED'
  }))
}

Page({
  data: {
    theme: 'standard',
    icons,
    members: [],
    loading: true,
    error: '',
    relations: RELATIONS,
    // 添加成员浮层
    sheetOpen: false,
    saving: false,
    form: Object.assign({}, EMPTY_FORM),
    formErr: ''
  },

  onLoad() {
    this.setData({ theme: app.globalData.theme || 'standard' })
    this.fetch()
  },

  /** 拉取成员列表（写操作成功后也会重新调用，保证列表=后端真相） */
  fetch() {
    this.setData({ loading: true, error: '' })
    return withFallback(userService.listFamilyMembers(), mockMembers)
      .then((list) => this.setData({ members: normalize(list), loading: false }))
      .catch((err) => this.setData({ members: [], loading: false, error: errText(err, '成员列表加载失败，请重试') }))
  },

  /** 头像加载失败 → 退回 CSS 人形占位（签名 URL 过期时不留白块） */
  onAvatarErr(e) {
    const index = Number((e.currentTarget.dataset || {}).index)
    if (isNaN(index)) return
    this.setData({ ['members[' + index + '].avatarErr']: true })
  },

  // 管理健康档案：契约红线 = 带 familyMemberId 的档案读写须 GRANTED 授权，且成员档案独立视图尚未上线
  onManage(e) {
    const item = this.data.members[Number(e.currentTarget.dataset.index)]
    if (!item) return
    wx.showModal({
      title: '管理 ' + (item.name || '成员') + ' 的健康档案',
      content: item.proxyGranted
        ? '已获得该成员的代管授权；成员档案的独立视图尚未上线，当前可维护成员信息。'
        : '该成员尚未完成代理授权，暂不能代管其健康档案。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  // 移除成员（DELETE /api/v1/family-members/{id}，成功后重新拉取列表）
  onRemove(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.members[index]
    if (!item) return
    wx.showModal({
      title: '移除成员',
      content: '确定移除 ' + (item.name || '该成员') + ' 吗？',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '处理中', mask: true })
        userService.removeFamilyMember(item.id)
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已移除', icon: 'success' })
            return this.fetch()
          })
          .catch((err) => {
            wx.hideLoading()
            wx.showToast({ title: errText(err, '移除失败，请重试'), icon: 'none' })
          })
      }
    })
  },

  /** 打开添加浮层 */
  onAdd() {
    this.setData({ sheetOpen: true, form: Object.assign({}, EMPTY_FORM), formErr: '' })
  },

  onSheetClose() {
    if (this.data.saving) return          // 提交在途不允许关闭（避免"已提交但没反馈"）
    this.setData({ sheetOpen: false, formErr: '' })
  },

  onInputName(e) {
    this.setData({ 'form.name': e.detail.value, formErr: '' })
  },

  onInputPhone(e) {
    this.setData({ 'form.phone': e.detail.value, formErr: '' })
  },

  onPickRelation(e) {
    this.setData({ 'form.relation': (e.currentTarget.dataset || {}).rel || '', formErr: '' })
  },

  /** 提交：前端先做必填/格式校验，再 POST（后端成功后才关浮层并刷新列表） */
  onSubmit() {
    if (this.data.saving) return
    const f = this.data.form
    const name = String(f.name || '').trim()
    const phone = String(f.phone || '').trim()
    if (!name) return this.setData({ formErr: '请填写成员姓名' })
    if (!f.relation) return this.setData({ formErr: '请选择与本人的关系' })
    if (phone && !/^1\d{10}$/.test(phone)) return this.setData({ formErr: '手机号格式不正确（11 位，1 开头）' })

    const payload = { displayName: name, relation: f.relation }
    if (phone) payload.phone = phone      // 契约里 phone 选填；不填不发，避免空串进库

    this.setData({ saving: true, formErr: '' })
    userService.createFamilyMember(payload)
      .then(() => {
        this.setData({ saving: false, sheetOpen: false, form: Object.assign({}, EMPTY_FORM) })
        wx.showToast({ title: '已添加', icon: 'success' })
        return this.fetch()
      })
      .catch((err) => {
        this.setData({ saving: false, formErr: errText(err, '添加失败，请重试') })
      })
  },

  /** 浮层遮罩/内容区的空处理器（catchtouchmove 阻断穿透滚动） */
  noop() {}
})
