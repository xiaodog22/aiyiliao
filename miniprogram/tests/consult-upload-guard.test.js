const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

/**
 * 上传入口回归（2026-11-15 合规收紧）：
 * 患者端在线问诊只允许从健康档案选图，任何「拍照 / 相册 / 微信文件 / 任意上传」入口
 * 一旦重新出现，本测试立即失败。
 */
const file = path.join(__dirname, '..', 'pages', 'consult', 'consult.js')
const src = fs.readFileSync(file, 'utf8')

test('consult.js 不再包含任意文件上传入口', () => {
  const forbidden = ['wx.chooseMedia', 'wx.chooseImage', 'wx.chooseMessageFile',
    'uploadStandaloneAttachment', '_uploadAndSend', '_pickImage', '_pickFile', '拍照上传']
  forbidden.forEach((token) => {
    assert.strictEqual(src.includes(token), false, `不应再出现上传入口：${token}`)
  })
})

test('consult.js 保留健康档案唯一入口与白名单校验', () => {
  assert.ok(src.includes('_pickFromHealthRecords'), '缺少健康档案选择入口')
  assert.ok(src.includes("image/webp"), '缺少 MIME 白名单')
  assert.ok(src.includes('IMAGE_MAX_BYTES'), '缺少大小上限校验')
})
