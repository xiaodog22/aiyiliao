/**
 * tools/test-fe-input-guard.js —— utils/input-guard.js 单元测试（DEF-09 回归）
 *
 * 背景：三个输入框此前只做 `trim()` 判空，`"。。。"` 能一路走到 AI 分诊任务，
 * 白烧 30~60s 推理再给一个无意义追问。本文件锁死两条：
 *   ① 纯空白/纯标点一律判为「无内容」；
 *   ② 任何真实输入（含单字「疼」「要」）都不能被误拦 —— 拦过头的代价是用户说不出话。
 *
 * 运行：node tools/test-fe-input-guard.js
 */
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')

const { hasContent, meaningfulLen } = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'input-guard.js'))

test('IG-01 纯标点 → 无内容（DEF-09 原始症状「。。。」）', () => {
  ['。。。', '，，', '！！！', '？？？', '、。！？', '~~~', '…—·', '()（）【】', '""', "''"].forEach((v) => {
    assert.strictEqual(hasContent(v), false, '应判为无内容：' + v)
  })
})

test('IG-02 空白（含全角空格）→ 无内容', () => {
  ['', '   ', '\t\n', '\u3000\u3000'].forEach((v) => {
    assert.strictEqual(hasContent(v), false, '应判为无内容：' + JSON.stringify(v))
  })
})

test('IG-03 单字真实输入不得误拦（路线询问应答词「要/好/是」）', () => {
  ['疼', '痛', '要', '好', '是', '晕'].forEach((v) => {
    assert.strictEqual(hasContent(v), true, '不应拦截：' + v)
  })
})

test('IG-04 正常症状描述 → 有内容', () => {
  ['嗓子疼三天', '肚子疼，还有点恶心', '饭后上腹隐痛三天，没有发热', 'ok', '120'].forEach((v) => {
    assert.strictEqual(hasContent(v), true, '不应拦截：' + v)
  })
})

test('IG-05 meaningfulLen：只减标点与空白，不减实义字符', () => {
  assert.strictEqual(meaningfulLen('嗓子疼，三天了。'), 6)
  assert.strictEqual(meaningfulLen('  。。。 '), 0)
  assert.strictEqual(meaningfulLen(null), 0)
  assert.strictEqual(meaningfulLen(undefined), 0)
})
