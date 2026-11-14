/*
 * e2e.spec.js —— 小程序 UI E2E（官方 miniprogram-automator）
 *
 * 两条旅程对应 DEV_LOG 里 V1.20 T4「E2E 两条旅程」：
 *   A 首页 → AI 智能导诊（只断言页面结构，不伪造分诊结果）
 *   B 预约挂号页（只断言结构，列表数据依赖后端，后端离线时不断言数据）
 * ⚠️ 不做 mockWxMethod / 不注入假数据；后端不可用时如实记录页面状态。
 */
'use strict'
const fs = require('fs')
const path = require('path')

async function runE2E(cfg, pre) {
  const need = ['DevTools CLI', 'DevTools 服务端口', '项目配置', 'miniprogram-automator']
  const missing = pre.checks.filter(c => need.includes(c.key) && c.status !== 'OK').map(c => c.key)
  if (missing.length) {
    return { status: 'SKIP', reason: '环境未就绪：' + missing.join('、'), cases: [] }
  }

  const automator = require('miniprogram-automator')
  const outDir = path.join(cfg.ARTIFACTS, 'e2e-' + Date.now())
  fs.mkdirSync(outDir, { recursive: true })
  const cases = []
  let miniProgram

  const shot = async name => {
    const p = path.join(outDir, name + '.png')
    try { await miniProgram.screenshot({ path: p }); return p } catch (e) { return '截图失败：' + e.message }
  }
  const runCase = async (name, fn) => {
    const c = { name, status: 'PASS', assertions: [], error: '' }
    try { await fn(c) } catch (e) { c.status = 'FAIL'; c.error = e.message }
    cases.push(c)
  }

  try {
    miniProgram = await automator.launch({
      cliPath: cfg.devtoolsCli,
      projectPath: cfg.projectPath,
      port: cfg.autoPort
    })

    await runCase('旅程A：首页 → AI 智能导诊（UI 结构）', async c => {
      const page = await miniProgram.reLaunch('/pages/home/home')
      await page.waitFor(600)
      const entry = await page.$('.hm-ai')
      if (!entry) throw new Error('首页导诊入口 .hm-ai 不存在')
      c.assertions.push('首页 .hm-ai 存在')
      await entry.tap()
      await page.waitFor(900)
      const title = await page.$('.tg-hero-title')
      if (!title) throw new Error('点击后未进入导诊页（.tg-hero-title 缺失）')
      const text = await title.text()
      if (!/梳理就医方向/.test(String(text))) throw new Error('导诊页标题异常：' + text)
      c.assertions.push('导诊页标题 = ' + text)
      c.screenshot = await shot('journey-a')
    })

    await runCase('旅程B：预约挂号页结构（不依赖后端数据）', async c => {
      const page = await miniProgram.reLaunch('/pages/appointment/appointment')
      await page.waitFor(600)
      if (!await page.$('.apt-page')) throw new Error('挂号页 .apt-page 不存在')
      c.assertions.push('挂号页根容器存在')
      if (!await page.$('.ap-search-in')) throw new Error('搜索框 .ap-search-in 不存在')
      c.assertions.push('搜索框存在（列表数据依赖后端，本用例不做数据断言）')
      c.screenshot = await shot('journey-b')
    })
  } catch (e) {
    cases.push({ name: '启动/连接开发者工具', status: 'FAIL', assertions: [], error: e.message })
  } finally {
    if (miniProgram) {
      try { await miniProgram.close() } catch (e) {
        cases.push({ name: '关闭会话', status: 'FAIL', assertions: [], error: e.message })
      }
    }
  }

  const failed = cases.filter(c => c.status === 'FAIL')
  return {
    status: failed.length ? 'FAIL' : 'PASS',
    reason: failed.length ? failed.map(c => c.name + '：' + c.error).join(' | ') : '',
    cases,
    outDir
  }
}

module.exports = { runE2E }
