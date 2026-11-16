/**
 * utils/flow-progress.js —— 「全流程就医」四步提示的唯一计算口径
 *
 * 背景（2026-11-15 缺陷）：AI 问诊 / AI 导诊两页各自实现了一遍取数逻辑，
 * 都写的是 `list[list.length - 1]`。但契约 `GET /api/v1/appointments/me`
 * 是「新→旧」返回，于是永远取到**最旧**那条 —— 用户完成新预约后提示不动。
 *
 * 这里只做纯计算（不发请求、不 setData），两页共用：
 *  - pickFocus：按时间与状态挑「当前最该关注」的一条，不依赖数组顺序；
 *  - buildProgress：把该条翻译成页面进度卡的 4 步口径。
 */
const { aptStatusText, isPastVisit } = require('./apt-status.js')

const ACTIVE = ['PENDING', 'CONFIRMED', 'CHECKED_IN']

function startTs(a) {
  const t = Date.parse(String((a && (a.startTime || a.createdAt)) || ''))
  return isNaN(t) ? 0 : t
}

/**
 * 挑当前最该关注的预约：
 *  1) CHECKED_IN（已取号候诊）优先，按时间取最近；
 *  2) 未过期的 CONFIRMED / PENDING，按最近开始时间取；
 *  3) 已过期的 CONFIRMED / PENDING，取最近一次（用于「上次预约已过期」提示）；
 *  4) 其它终态（完成/取消/爽约）取最近一条。
 */
function pickFocus(list) {
  const arr = (Array.isArray(list) ? list : []).filter(Boolean)
  if (!arr.length) return null
  const now = Date.now()

  const checkedIn = arr
    .filter((a) => String(a.status || '').trim().toUpperCase() === 'CHECKED_IN')
    .sort((a, b) => startTs(b) - startTs(a))
  if (checkedIn.length) return checkedIn[0]

  const active = arr.filter((a) => ACTIVE.indexOf(String(a.status || '').trim().toUpperCase()) >= 0)
  const upcoming = active
    .filter((a) => startTs(a) >= now - 30 * 60 * 1000)
    .sort((a, b) => startTs(a) - startTs(b))
  if (upcoming.length) return upcoming[0]

  const expired = active.sort((a, b) => startTs(b) - startTs(a))
  if (expired.length) return expired[0]

  return arr.slice().sort((a, b) => startTs(b) - startTs(a))[0] || null
}

/**
 * 生成进度卡数据（与页面原字段保持一致：title / subtitle / step / hasFlow）。
 * 列表为空时返回 hasFlow=false —— 调用方必须无条件 setData，不能保留旧文案。
 *
 * @param {Array} list 预约列表（GET /api/v1/appointments/me）
 * @param {string} title 进度卡标题
 * @param {object} [consult] 进行中的线上问诊（GET /api/v1/consultations 最新 ACTIVE 一条）：
 *   没有预约时用它兜底，避免「全程陪诊」在问诊进行中完全不更新（2026-11-15）。
 */
function buildProgress(list, title, consult) {
  const t = title || '小安陪您全流程就医'
  const latest = pickFocus(list)
  if (!latest) {
    const c = consult && consult.id ? consult : null
    if (c && String(c.status || 'ACTIVE').trim().toUpperCase() === 'ACTIVE') {
      return {
        title: t,
        subtitle: c.accepting
          ? '线上问诊 | 医生已接单，点击继续沟通'
          : '线上问诊 | 待医生接单，已提交病情描述',
        step: c.accepting ? 2 : 1,
        hasFlow: true
      }
    }
    return { title: t, subtitle: '', step: 1, hasFlow: false }
  }

  const raw = String(latest.status || '').trim().toUpperCase()
  const dept = latest.departmentName || ''
  const prefix = dept ? (dept + '门诊 | ') : ''
  let step = 1
  let subtitle = ''

  if ((raw === 'CONFIRMED' || raw === 'PENDING') && isPastVisit(latest.startTime, latest.endTime)) {
    subtitle = prefix + '上次预约已过期，可重新预约或继续咨询'
  } else if (raw === 'CONFIRMED') {
    step = 2
    subtitle = prefix + '您好！您的预约已确认，请按时到院取号'
  } else if (raw === 'CHECKED_IN') {
    step = 3
    subtitle = prefix + '您已取号，请前往诊室候诊'
  } else if (raw === 'COMPLETED') {
    step = 4
    subtitle = prefix + '本次就诊已完成，祝您早日康复'
  } else {
    subtitle = prefix + '当前预约状态：' + aptStatusText(raw)
  }
  return { title: t, subtitle, step, hasFlow: true }
}

module.exports = { pickFocus, buildProgress }
