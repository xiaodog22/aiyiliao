#!/usr/bin/env node
/**
 * tools/check-build-env.js —— 发版档位硬门禁（P0-01 第一道防线）
 *
 * 背景（docs/测试报告_分片A_登录鉴权.md §0）：
 *   仓库入库值 BUILD_ENV='development' 时，手输登录与 dev 派生 code 随包生效
 *   —— 任意 11 位号码 + 任意密码即可拿到患者真会话，任意账号即可拿到医生会话。
 *   生产隔离此前只有"发版时人工把它改成 production"这一处开关，没有任何自动校验。
 *
 * 本脚本把"人工开关"变成可执行断言：
 *   ① 不注入 env.local.js 时，env.js 必须落 production 且加载期 fail-closed（缺 HTTPS 网关）
 *   ② env.local.js 注入 production + HTTPS 网关后必须能正常加载，且 gateway 取注入值
 *   ③ production 档禁止携带 devLoginKey（env.local.js 误配即构建失败）
 *   ④ 源码里不得出现真实隧道域名 / 联调密钥形态
 *   ⑤ 后端默认 profile 与联调登录闸门必须 fail-closed
 *
 * ⚠️ 2026-11-24（BUG-004）：原实现用**字面量正则**匹配 BUILD_ENV 表达式，
 *    env.js 为 Node 单测加了 `IS_NODE_TEST ? 'local' : (...)` 三元后正则必然不匹配，
 *    门禁恒红（exit 1）—— README「两者应同时为绿」不可达成。
 *    现改为**行为级校验**：把 env.js 复制到临时目录、配不同 env.local.js 真实加载一次，
 *    断言"加载结果/抛错"而不是源码写法。档位表达式以后怎么改都不会假红。
 *
 * 用法：
 *   node tools/check-build-env.js             # 发版流水线/出体验版前必跑；失败 exit 1
 *   node tools/check-build-env.js --allow-dev # 本地体检：只提示不判失败（CI 不要用）
 *
 * 退出码：0 = 可发版；1 = 不可发版（含具体原因）
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const ENV_PATH = path.join(__dirname, '..', 'miniprogram', 'config', 'env.js')
const ALLOW_DEV = process.argv.indexOf('--allow-dev') >= 0

/**
 * 行为级探测：把 env.js 复制到临时目录，按需配一份 env.local.js，真实 require 一次。
 * @param {Object|null} overrides env.local.js 的内容；null = 不放该文件
 * @returns {{ok:true, env:Object}|{ok:false, error:Error}}
 */
function probeEnv(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-env-probe-'))
  // WB_NODE_TEST 会让 env.js 强制走 local 档（Node 单测专用），探测时必须屏蔽，
  // 否则"默认档位是否 production"永远测不出来。
  const savedNodeTest = process.env.WB_NODE_TEST
  delete process.env.WB_NODE_TEST
  try {
    fs.copyFileSync(ENV_PATH, path.join(dir, 'env.js'))
    if (overrides) {
      fs.writeFileSync(path.join(dir, 'env.local.js'),
        'module.exports = ' + JSON.stringify(overrides) + '\n', 'utf8')
    }
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      return { ok: true, env: require(path.join(dir, 'env.js')) }
    } catch (e) {
      return { ok: false, error: e }
    }
  } finally {
    if (savedNodeTest === undefined) delete process.env.WB_NODE_TEST
    else process.env.WB_NODE_TEST = savedNodeTest
    Object.keys(require.cache).forEach((k) => { if (k.indexOf(dir) === 0) delete require.cache[k] })
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function main() {
  if (!fs.existsSync(ENV_PATH)) {
    console.error('✗ 找不到 miniprogram/config/env.js')
    process.exitCode = 1
    return
  }
  const src = fs.readFileSync(ENV_PATH, 'utf8').replace(/\r\n/g, '\n')
  const problems = []

  // ── ① 默认档位：无 env.local.js 时必须落 production 且加载期 fail-closed ──
  const bare = probeEnv(null)
  let defaultEnv = 'production'
  if (bare.ok) {
    defaultEnv = String(bare.env.name || '')
    if (defaultEnv !== 'production') {
      problems.push({ devOnly: true, msg: '无 env.local.js 时默认档位不是 production（当前：' + (defaultEnv || '(空)') + '）' })
    }
    if (bare.env.gateway) {
      problems.push({ devOnly: true, msg: 'env.js 内置了 production.gateway（正式域名不得入库）' })
    }
  } else {
    const msg = String((bare.error && bare.error.message) || bare.error || '')
    // 预期就是这句：默认 production + 无内置网关 → 加载期直接拒绝
    if (!/production 档缺少 HTTPS 网关/.test(msg)) {
      problems.push({ devOnly: false, msg: '无 env.local.js 时 env.js 未按预期 fail-closed：' + msg })
    }
  }

  // ── ② 发版路径：注入 production + HTTPS 网关后必须能加载 ──
  const release = probeEnv({ buildEnv: 'production', productionGateway: 'https://release.example.com' })
  if (!release.ok) {
    problems.push({ devOnly: false, msg: 'production 档在注入 HTTPS 网关后仍加载失败：' + ((release.error && release.error.message) || release.error) })
  } else {
    const gw = String(release.env.gateway || '')
    if (release.env.name !== 'production' || !/^https:\/\//i.test(gw)) {
      problems.push({ devOnly: false, msg: 'production 档未按 env.local.js 生效（档位=' + release.env.name + '，gateway=' + (gw || '(空)') + '）' })
    }
  }

  // ── ③ production 档禁止携带 devLoginKey（误配即构建失败） ──
  const leak = probeEnv({
    buildEnv: 'production',
    productionGateway: 'https://release.example.com',
    devLoginKey: 'probe-only-not-a-real-key'
  })
  if (leak.ok && String(leak.env.devLoginKey || '')) {
    problems.push({ devOnly: false, msg: 'production 档未拒绝 env.local.js 注入的 devLoginKey（应构建失败）' })
  }

  // ── ④ 联调档仍可正常装配（白名单不能被改坏） ──
  const localProbe = probeEnv({ buildEnv: 'local', localGateway: 'http://127.0.0.1:8080' })
  if (!localProbe.ok || localProbe.env.name !== 'local' || !localProbe.env.legacyManualLoginEnabled) {
    problems.push({ devOnly: false, msg: 'local 档加载异常：' + (localProbe.ok ? ('档位=' + localProbe.env.name) : ((localProbe.error && localProbe.error.message) || localProbe.error)) })
  }

  // 构建期实际档位：有 env.local.js 时以它为准（发布流水线生成），否则就是默认值
  let effectiveEnv = defaultEnv
  const localPath = path.join(path.dirname(ENV_PATH), 'env.local.js')
  if (fs.existsSync(localPath)) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const ov = require(localPath) || {}
      if (ov.buildEnv) effectiveEnv = String(ov.buildEnv).trim()
    } catch (e) {
      console.error('✗ env.local.js 存在但无法解析：' + e.message)
      process.exitCode = 1
      return
    }
  }

  console.log('· BUILD_ENV 默认 = ' + defaultEnv + '（本次生效：' + effectiveEnv + '）')
  console.log('· 发版路径探针 = ' + (release.ok ? ('production + ' + String(release.env.gateway || '')) : '失败'))

  // ③b 源码里不得出现真实隧道域名 / dev 登录密钥形态（审计 C1/H8）
  // 只认「真实地址形态」（带协议前缀或裸内网 IP）；校验规则里的字面量
  // （如 TEMPORARY_HOST 的 vicp[.]fun）不算泄露，否则门禁自己会自命中。
  if (/(?:https?:\/\/|\/\/)[^\s'"]*(?:vicp[.]fun|ngrok|natapp)|172[.]29[.]188[.]115/i.test(src)) {
    problems.push({ devOnly: false, msg: 'env.js 含真实隧道域名/内网地址（应移到 env.local.js）' })
  }
  if (/wb-devlogin-[0-9a-f]{16,}/i.test(src)) {
    problems.push({ devOnly: false, msg: 'env.js 含 dev 登录密钥（应移到 env.local.js）' })
  }
  if (effectiveEnv !== 'production') {
    problems.push({ devOnly: true, msg: '本次构建档位是 ' + effectiveEnv + '（发版必须是 production）' })
  }

  // ④ 后端侧：spring.profiles.default 必须不是 dev（2026-10-29 起为 prod），
  //    且联调登录闸门默认关闭 —— 否则「误以 dev 档部署 + 隧道暴露」就能拿到真会话。
  const appYml = path.join(__dirname, '..', 'backend', 'business-service', 'src', 'main', 'resources', 'application.yml')
  if (fs.existsSync(appYml)) {
    // Windows 检出是 CRLF：`.` 不匹配 \r，不归一化会让 `(?:.*\n)*?` 直接匹配失败，
    // 后端档位检查退化成「(未声明)」——看着跑过、其实没检查（2026-11-24 · BUG-004）。
    const y = fs.readFileSync(appYml, 'utf8').replace(/\r\n/g, '\n')
    const prof = /profiles:\s*\n(?:.*\n)*?\s*default:\s*(\S+)/.exec(y)
    const defProf = prof ? prof[1] : '(未声明)'
    console.log('· business-service spring.profiles.default = ' + defProf)
    if (/^dev$/.test(defProf)) {
      problems.push({ devOnly: false, msg: '后端默认 profile 仍是 dev（应显式声明 prod，dev 由部署侧显式打开）' })
    }

    const gate = /dev-login:\s*\n\s*enabled:\s*\$\{APP_AUTH_DEV_LOGIN_ENABLED:(\w+)\}/.exec(y)
    const defEnabled = gate ? gate[1] : '(未声明)'
    console.log('· 联调登录闸门默认 enabled = ' + defEnabled)
    if (!gate || gate[1] !== 'false') {
      problems.push({ devOnly: false, msg: '联调登录闸门默认值不是 false（应 fail-closed）' })
    }
  }

  if (!problems.length) {
    const gw = (release.ok && String(release.env.gateway || '')) || ''
    console.log('✓ 发版门禁通过：production 档 + 默认 fail-closed + 后端默认档位/闸门 fail-closed'
      + '（正式网关：' + (gw || '未注入，发版包由流水线 env.local.js 提供') + '）')
    return
  }

  const blocking = []
  problems.forEach((p) => {
    const downgraded = ALLOW_DEV && p.devOnly
    console.error((downgraded ? '⚠ ' : '✗ ') + p.msg)
    if (!downgraded) blocking.push(p.msg)
  })
  if (!blocking.length) {
    console.log('（--allow-dev：联调包体检通过；安全默认项均 fail-closed。发版时不得带此参数）')
    return
  }
  console.error('✗ 发版门禁不通过：见上方 ✗ 项')
  process.exitCode = 1
}

main()
