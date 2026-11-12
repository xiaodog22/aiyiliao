/**
 * utils/input-guard.js —— 「这段输入到底有没有实际内容」的判定（纯函数，node 可直接单测）
 *
 * 为什么需要它（2026-11-12 缺陷 DEF-09）：三个聊天/导诊输入框此前只做 `trim()` 判空，
 * `"。。。"`、`"，，"`、`"！！！"` 这类**只有标点**的输入都能通过，导诊页甚至会把它
 * 送进 AI 分诊任务链（CPU 上 30~60s 推理），最后给出一个毫无意义的追问。
 *
 * 判据刻意保守：只拦「去掉空白与标点后一个字都不剩」的输入。
 *  - 不设最小长度：`"疼"`、`"要"`（路线询问的应答词）必须照常通过；
 *  - 不判语义：`"嗯"`、`"好"`、`"1"` 都算有内容 —— 是否处理交给业务逻辑。
 */

/** 空白 + 中英文标点 + 常见装饰符号（这些字符本身不承载症状/诉求信息）。 */
const NOISE = /[\s\u3000，。！？、；：,.!?;:~…—\-·"'“”‘’()（）【】\[\]《》<>/\\|@#$%^&*+=_]/g

/**
 * 有效字符数（去掉空白与标点后的长度）。
 * @param {*} text
 * @returns {number}
 */
function meaningfulLen(text) {
  const s = String(text == null ? '' : text).replace(NOISE, '')
  return s.length
}

/**
 * 是否有实际内容。
 * @param {*} text
 * @returns {boolean} false = 纯空白/纯标点，调用方应就地拦下、不发请求
 */
function hasContent(text) {
  return meaningfulLen(text) > 0
}

module.exports = { meaningfulLen, hasContent }
