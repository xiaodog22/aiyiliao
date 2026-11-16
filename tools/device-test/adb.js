'use strict'
/**
 * adb.js —— adb 探测与命令封装（零第三方依赖）
 *
 * 设计边界：
 *  - 不硬编码任何「后端地址/端口」：本文件只跟设备打交道，HTTP 断言由 run.js 从
 *    miniprogram/config/env.js 解析网关（全仓唯一放行点）。
 *  - adb 路径可被 ADB_PATH 覆盖；否则按「本机实证路径 → ANDROID_HOME → PATH」顺序探测。
 *    探测不到时抛 AdbUnavailable（调用方按 SKIP 处理，不伪造通过）。
 *  - 所有命令走 execFileSync 参数数组，不拼 shell 字符串，避免路径含空格/中文被拆坏。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const IS_WIN = process.platform === 'win32'
const EXE = IS_WIN ? 'adb.exe' : 'adb'

class AdbUnavailable extends Error {}

/** 候选路径：顺序即优先级。最后一项 'adb' 表示交给 PATH 解析。 */
function adbCandidates() {
  const out = []
  if (process.env.ADB_PATH) out.push(process.env.ADB_PATH)
  // 本机实证：微信开发者工具自带 adb（见 tools/e2e-weapp/device/dtest.sh:17）
  out.push('D:/OpenWeChar/微信web开发者工具/bin/adb-win/adb.exe')
  out.push('C:/Program Files (x86)/Tencent/微信web开发者工具/bin/adb-win/adb.exe')
  if (process.env.ANDROID_HOME) out.push(path.join(process.env.ANDROID_HOME, 'platform-tools', EXE))
  if (process.env.ANDROID_SDK_ROOT) out.push(path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', EXE))
  if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', EXE))
  out.push(EXE)
  return out
}

function findAdbPath() {
  for (const p of adbCandidates()) {
    if (p === EXE) {
      try {
        execFileSync(EXE, ['version'], { stdio: 'ignore', timeout: 8000, windowsHide: true })
        return EXE
      } catch (e) { /* PATH 里也没有，继续 */ }
      continue
    }
    if (fs.existsSync(p)) return p
  }
  return ''
}

function createAdb(adbPath) {
  const bin = adbPath || findAdbPath()
  if (!bin) {
    throw new AdbUnavailable(
      '未找到 adb。请设置 ADB_PATH 指向 adb(.exe)，或安装 Android platform-tools 并加入 PATH。')
  }

  const run = (args, opts = {}) => execFileSync(bin, args, {
    encoding: opts.encoding === 'buffer' ? 'buffer' : 'utf8',
    timeout: opts.timeout || 20000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const sArgs = (serial, rest) => (serial ? ['-s', serial, ...rest] : rest)

  return {
    bin,

    version() {
      return run(['version']).trim()
    },

    /** [{serial, state}]；state=device 才可用。 */
    devices() {
      const text = run(['devices'])
      return text.split(/\r?\n/).slice(1)
        .map(l => l.trim()).filter(Boolean)
        .map(l => {
          const [serial, state] = l.split(/\s+/)
          return { serial, state }
        })
    },

    /** 选设备：显式 serial 优先；否则取第一台 state=device；都没有则抛错。 */
    pickDevice(serial) {
      const list = this.devices()
      if (serial) {
        const hit = list.find(d => d.serial === serial)
        if (!hit || hit.state !== 'device') {
          throw new AdbUnavailable(`设备 ${serial} 不可用（state=${hit ? hit.state : 'not-found'}）`)
        }
        return serial
      }
      const ready = list.filter(d => d.state === 'device')
      if (!ready.length) {
        throw new AdbUnavailable('没有处于 device 状态的设备（检查 USB 调试授权 / adb devices）')
      }
      return ready[0].serial
    },

    /** 物理分辨率（不看 override size）。 */
    wmSize(serial) {
      const text = run(sArgs(serial, ['shell', 'wm', 'size']))
      const m = text.match(/Physical size:\s*(\d+)x(\d+)/)
      return m ? { width: Number(m[1]), height: Number(m[2]) } : null
    },

    screenState(serial) {
      // mScreenOn= true/false（部分 ROM 字段名不同，取不到就返回 null，不猜）
      try {
        const text = run(sArgs(serial, ['shell', 'dumpsys', 'power']))
        const m = text.match(/mWakefulness=(\w+)/)
        return m ? m[1] : null
      } catch (e) { return null }
    },

    wake(serial) {
      run(sArgs(serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']))
    },

    tap(serial, x, y) {
      run(sArgs(serial, ['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]))
    },

    swipe(serial, x1, y1, x2, y2, durationMs = 300) {
      run(sArgs(serial, ['shell', 'input', 'swipe',
        String(Math.round(x1)), String(Math.round(y1)),
        String(Math.round(x2)), String(Math.round(y2)), String(Math.round(durationMs))]))
    },

    /** ASCII 文本输入；空格转 %s（adb input 约定），中文不支持时如实报错给调用方。 */
    inputText(serial, text) {
      const encoded = String(text).replace(/ /g, '%s')
      run(sArgs(serial, ['shell', 'input', 'text', encoded]))
    },

    keyevent(serial, code) {
      run(sArgs(serial, ['shell', 'input', 'keyevent', String(code)]))
    },

    /**
     * 截图写盘。优先 exec-out（不落 /sdcard，权限问题少）；失败回退 screencap + pull。
     * 返回 { path, bytes }；非 PNG（典型是 Windows CRLF 损坏）时抛错，避免把坏图当证据。
     */
    screencap(serial, outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      let buf = null
      try {
        buf = run(sArgs(serial, ['exec-out', 'screencap', '-p']), { encoding: 'buffer', timeout: 25000 })
      } catch (e) {
        buf = null
      }
      if (!buf || buf.length < 1024 || buf[0] !== 0x89 || buf[1] !== 0x50) {
        // 回退：先落设备再 pull（老设备 exec-out 会把 \n 转成 \r\n）
        const remote = '/sdcard/_device_test.png'
        run(sArgs(serial, ['shell', 'screencap', '-p', remote]), { timeout: 25000 })
        run(sArgs(serial, ['pull', remote, outPath]), { timeout: 25000 })
        try { run(sArgs(serial, ['shell', 'rm', '-f', remote])) } catch (e) { /* 清理失败不影响证据 */ }
        const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0
        if (!size) throw new Error('截图失败：exec-out 与 pull 均未取得文件')
        return { path: outPath, bytes: size }
      }
      fs.writeFileSync(outPath, buf)
      return { path: outPath, bytes: buf.length }
    },

    logcatClear(serial) {
      try { run(sArgs(serial, ['logcat', '-c'])) } catch (e) { /* 部分 ROM 需 root，忽略 */ }
    },

    /** dump 当前缓冲区（-d 不阻塞），最多取最近 4000 行，避免报告爆掉。 */
    logcatDump(serial) {
      try {
        const text = run(sArgs(serial, ['logcat', '-d', '-v', 'time']), { timeout: 30000 })
        const lines = text.split(/\r?\n/)
        return lines.slice(-4000).join('\n')
      } catch (e) {
        return ''
      }
    },

    /** 当前前台窗口/Activity（用于判断小程序是否在前台，取不到返回空串）。 */
    currentFocus(serial) {
      try {
        const text = run(sArgs(serial, ['shell', 'dumpsys', 'window']))
        const m = text.match(/mCurrentFocus=([^\n]+)/)
        return m ? m[1].trim() : ''
      } catch (e) { return '' }
    }
  }
}

module.exports = { createAdb, findAdbPath, AdbUnavailable }
