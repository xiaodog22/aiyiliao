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
 *   ① BUILD_ENV 必须等于 'production'（local/development 一律拒绝）
 *   ② production.gateway 必须是非空 https，且不含临时调试域名
 *      （env.js 自身也会 throw，但构建期先拦下来，报错信息更直接）
 *
 * 用法：
 *   node tools/check-build-env.js             # 发版流水线/出体验版前必跑；失败 exit 1
 *   node tools/check-build-env.js --allow-dev # 本地体检：只提示不判失败（CI 不要用）
 *
 * 退出码：0 = 可发版；1 = 不可发版（含具体原因）
 */
const fs = require('fs')
const path = require('path')

const ENV_PATH = path.join(__dirname, '..', 'miniprogram', 'config', 'env.js')
const ALLOW_DEV = process.argv.indexOf('--allow-dev') >= 0
const TEMPORARY_HOST = /(vicp\.fun|ngrok|natapp|localhost|127\.0\.0\.1)/i

function main() {
  if (!fs.existsSync(ENV_PATH)) {
    console.error('✗ 找不到 miniprogram/config/env.js')
    process.exitCode = 1
    return
  }
  const src = fs.readFileSync(ENV_PATH, 'utf8')

  const m = /const BUILD_ENV\s*=\s*'([^']*)'/.exec(src)
  if (!m) {
    console.error("✗ env.js 中未找到 `const BUILD_ENV = '...'`，无法判定档位")
    process.exitCode = 1
    return
  }
  const buildEnv = m[1]

  // production 块内的 gateway（注意：不能取 development 的隧道地址）
  const prodBlock = /production:\s*\{([\s\S]*?)\}/.exec(src)
  const gwMatch = prodBlock ? /gateway:\s*'([^']*)'/.exec(prodBlock[1]) : null
  const gateway = (gwMatch ? gwMatch[1] : '').trim()

  console.log('· BUILD_ENV = ' + buildEnv)
  console.log('· production.gateway = ' + (gateway || '(空)'))

  // devOnly=true：只影响「能否发正式包」，--allow-dev 下降级为提示（联调包用隧道网关）；
  // devOnly=false：安全默认项，任何模式都不降级（后端档位/闸门/生产不携带联调头）。
  const problems = []
  if (buildEnv !== 'production') problems.push({ devOnly: true, msg: 'BUILD_ENV 不是 production（当前：' + buildEnv + '）' })
  if (!/^https:\/\//i.test(gateway)) problems.push({ devOnly: true, msg: 'production.gateway 必须是 https 地址' })
  else if (TEMPORARY_HOST.test(gateway)) problems.push({ devOnly: true, msg: 'production.gateway 仍是临时调试域名：' + gateway })

  // ③ 前端侧：production 档不得下发联调登录头（devLoginKey 必须被强制为空）
  if (!/devLoginKey:\s*DEV_ONLY\s*\?\s*DEV_LOGIN_KEY\s*:\s*''/.test(src)) {
    problems.push({ devOnly: false, msg: 'env.js 的 devLoginKey 未按 `DEV_ONLY ? DEV_LOGIN_KEY : ""` 强制生产为空' })
  }

  // ④ 后端侧：spring.profiles.default 必须不是 dev（2026-10-29 起为 prod），
  //    且联调登录闸门默认关闭 —— 否则「误以 dev 档部署 + 隧道暴露」就能拿到真会话。
  const appYml = path.join(__dirname, '..', 'backend', 'business-service', 'src', 'main', 'resources', 'application.yml')
  if (fs.existsSync(appYml)) {
    const y = fs.readFileSync(appYml, 'utf8')
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
    console.log('✓ 发版门禁通过：production + 正式 HTTPS 网关 + 后端默认档位/闸门 fail-closed')
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
