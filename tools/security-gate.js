#!/usr/bin/env node
/**
 * security-gate.js —— 仓库级敏感信息 / 安全档位门禁（H8/H9）
 *
 * 用法：
 *   node tools/security-gate.js                  # 扫描 git 已跟踪文件
 *   node tools/security-gate.js --all            # 扫描工作区（含未跟踪，排除 .git/node_modules/target）
 *   node tools/security-gate.js --staged         # 只扫描暂存区（pre-commit）
 *   node tools/security-gate.js --warn-only      # 只告警，不阻断（接入初期）
 *
 * 退出码：0 = 通过；1 = 命中；2 = 脚本自身错误。
 *
 * 设计说明：
 *   - 不打印完整敏感值，只打印前 6 位 + 掩码，避免 CI 日志二次泄露。
 *   - docs/security/** 是整改方案自身（含 Before/After 示例），显式排除；
 *     但 `--all` 仍会扫描生产代码与配置。
 *   - 规则按“报告发现编号”命名，命中即可回溯到审计项。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.cwd();
const ARGS = new Set(process.argv.slice(2));
const WARN_ONLY = ARGS.has('--warn-only');
const SCAN_ALL = ARGS.has('--all');
const STAGED = ARGS.has('--staged');

const EXCLUDE_DIRS = [
  '.git', 'node_modules', 'target', 'dist', 'build', 'coverage',
  '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'archive',
  'docs',                                  // 历史文档含旧环境值，另行做文档脱敏专项
  'docs/security/2026-11-18-remediation', // 整改文档自身（含示例值）
  'backend/deploy/resources',             // 静态资源（非代码）
];

// 测试夹具、目标态契约、运维脚本不进入“可发布产物”门禁；
// 这些路径的真实密钥泄露由独立的 test-fixture 审计处理。
const EXCLUDE_SEGMENTS = [
  '/src/test/',
  '/src/test/resources/',
  '/backend/contracts/',
  '/backend/deploy/scripts/',
];

const EXCLUDE_FILES = [
  'tools/security-gate.js', // 规则自身
  'tools/test-security-defaults.js', // 规则的合成样例（故意包含危险字符串）
  'package-lock.json',
  'pnpm-lock.yaml',
];

const SCAN_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.java', '.kt', '.py', '.go', '.rb', '.php',
  '.yml', '.yaml', '.json', '.properties', '.env', '.ini', '.conf', '.toml',
  '.xml', '.gradle', '.sql', '.sh', '.ps1', '.bat', '.cmd',
  '.md', '.txt', '.wxml', '.wxss', '.html',
]);

const MAX_BYTES = 2 * 1024 * 1024;

/** 规则表：id / 说明 / 正则 / 允许路径（可选） */
const RULES = [
  {
    id: 'C1-LEAKED-DEV-KEY',
    desc: '已泄露的 dev 登录密钥（前端/配置/文档）',
    re: /wb-devlogin-[0-9a-f]{16,}/i,
    // DevLoginGuard 的 revoked-keys 是撤销名单，保留旧值是为了拒绝它们；不是泄露。
    allow: [/DevLoginGuard\.java$/],
  },
  {
    id: 'H8-TUNNEL-HOST',
    desc: '临时内网穿透域名或实验室固定 IP',
    re: /(vicp\.fun|ngrok\.(io|app)|natappfree|172\.29\.188\.115)/i,
  },
  {
    id: 'H7-WEAK-DB-PASSWORD',
    desc: '数据库弱默认口令 / root 直连',
    re: /(MYSQL_ROOT_PASSWORD\s*:\s*\$\{[^}]+:-local_root\}|MYSQL_ROOT_PASSWORD\s*:\s*local_root|MYSQL_PASSWORD\s*:\s*\$\{[^}]+:-local_root\}|MYSQL_USER\s*:\s*root|password\s*[:=]\s*['"]?local_root['"]?)/i,
  },
  {
    id: 'H7-DB-PORT-EXPOSED',
    desc: '数据库/业务/AI 端口发布到宿主机（应仅 gateway 出网）',
    re: /ports\s*:\s*\[\s*["']?(13306|18088|18001):/,
    allow: [/docker-compose\.local\.yml$/],
  },
  {
    id: 'H7-GATEWAY-PORT-ALL',
    desc: '网关端口绑定所有网卡（应 127.0.0.1 供 frp 回环转发）',
    re: /ports\s*:\s*\[\s*["']?(0\.0\.0\.0:)?(18080|8080):8080["']?\s*\]/,
  },
  {
    id: 'H7-PROFILE-DEV',
    desc: 'compose/配置把 dev 档写死（未显式注入 prod）',
    re: /SPRING_PROFILES_ACTIVE\s*:\s*["']?dev["']?/,
    allow: [/docker-compose\.local\.yml$/, /\.md$/],
  },
  {
    id: 'H7-DEV-PHONE-KEY',
    desc: '手机号加密 dev 占位密钥（Base64）',
    re: /MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=/,
    // application.yml 的 dev profile 允许占位值（仅 dev 生效）；
    // 生产是否误用由 ProductionSecurityCheck 硬阻断。
    allow: [/src\/test\//, /application\.yml$/],
  },
  {
    id: 'M5-DEV-SIGN-SECRET',
    desc: '附件/头像签名 dev 占位密钥',
    re: /local-only-sign-secret-please-change/,
  },
  {
    id: 'M6-DEV-VOICE-SECRET',
    desc: '语音缓存 dev 占位密钥（仅匹配代码使用，不匹配注释）',
    re: /(getOrDefault\s*\(\s*["']VOICE_CACHE_SECRET["']\s*,\s*["']wechar-dev-tts-cache-secret["']|return\s+["']wechar-dev-tts-cache-secret["'])/,
  },
  {
    id: 'H1-SMS-FAIL-OPEN',
    desc: '条件装配缺省启用（matchIfMissing=true，可能静默启用 dev/mock 实现）',
    // 只匹配注解上下文，避免把文档/注释里的说明文字当成危险默认。
    re: /@ConditionalOnProperty\s*\([\s\S]{0,600}?matchIfMissing\s*=\s*true/,
    allow: [
      /src\/test\//,
      // DisabledHisClient 的缺省装配是 fail-safe（任何调用 503），不是启用外部/mock。
      /DisabledHisClient\.java$/,
    ],
  },
  {
    id: 'L6-HIS-MOCK-FAIL-OPEN',
    desc: 'HIS 配置把 mode 设为 mock（生产禁止演示受理）',
    // 只看 yml 中 his: 块内 10 行内的 mode: mock；代码里的 havingValue="mock" 是合法装配条件。
    re: /his\s*:\s*\n(?:[^\n]*\n){0,10}?[ \t]*mode\s*:\s*['"]?mock['"]?/i,
    allow: [/src\/test\//, /application-itest\.yml$/, /\.md$/],
  },
  {
    id: 'L6-HIS-MODE-ENV-MOCK',
    desc: 'HIS 模式环境变量设为 mock（生产/自定义 profile 禁止演示受理）',
    // 2026-11-23（B3 复审 P2）：compose/env 里的 APP_HIS_MODE 与 yml 同等对待；
    // 仅测试/文档允许出现，生产必须 disabled|http 且由启动自检二次拦截。
    re: /^\s*APP_HIS_MODE\s*[:=]\s*['"]?mock['"]?/im,
    allow: [/src\/test\//, /application-itest\.yml$/, /\.md$/],
  },
  {
    id: 'H3-AUTH-OFF',
    desc: '生产配置出现认证 off 档',
    // 只匹配“配置行首”的赋值，避免命中代码注释/文档正文中的示例
    re: /^\s*(APP_AUTH_MODE|app\.auth\.mode|AI_AUTH_MODE|ai\.auth\.mode)\s*[:=]\s*['"]?off['"]?/im,
    allow: [/application-itest\.yml$/, /src\/test\//, /\.md$/],
  },
  {
    id: 'H9-BUILD-ENV-DEV',
    desc: 'env.js 提交态仍为 development（应为 production 默认）',
    re: /const\s+BUILD_ENV\s*=\s*['"]development['"]/,
  },
  {
    id: 'H9-DEV-LOGIN-KEY-ASSIGN',
    desc: '前端直接赋值 devLoginKey 常量（应来自 env.local.js）',
    re: /const\s+DEV_LOGIN_KEY\s*=\s*['"][^'"]{8,}['"]/,
  },
  {
    id: 'M10-DEMO-ACCOUNT',
    desc: '演示账号/口令组合',
    re: /(13900139001|13800138001)\s*[,/|]\s*(doc123|patient123|demo123)/i,
    allow: [/src\/test\//],
  },
  {
    id: 'M10-DEMO-PHONE',
    desc: '演示医生手机号（应改为不可登录的占位号）',
    re: /13900139001/,
    allow: [
      /src\/test\//,
      /\.md$/,
      /resources\/db\/dev\//,          // 仅 dev 档迁移，生产不执行
      /DevWechatSessionProvider\.java$/, // @Profile("dev")，生产不装配
      /edge-gateway\/app\/compat\.py$/,  // 网关 dev 兼容路由
      /tools\/test-login-auth-audit\.js$/, // 测试脚本
    ],
  },
  {
    id: 'M10-MOCK-DOCTOR',
    desc: 'mock 数据中的医生口令字段',
    re: /(role\s*:\s*['"]DOCTOR['"][^\n]{0,80}password\s*:|password\s*:\s*['"]doc123['"])/i,
    allow: [/src\/test\//],
  },
  {
    id: 'SEC-AWS-KEY',
    desc: 'AWS Access Key',
    re: /AKIA[0-9A-Z]{16}/,
  },
  {
    id: 'SEC-OPENAI-KEY',
    desc: 'OpenAI/DeepSeek 风格 API Key',
    re: /sk-[A-Za-z0-9]{20,}/,
  },
  {
    id: 'SEC-GITHUB-TOKEN',
    desc: 'GitHub Token',
    re: /gh[pousr]_[A-Za-z0-9]{30,}/,
  },
  {
    id: 'SEC-SLACK-TOKEN',
    desc: 'Slack Token',
    re: /xox[baprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    id: 'SEC-PRIVATE-KEY',
    desc: '私钥文件内容',
    re: /-----BEGIN\s+(RSA|EC|OPENSSH|DSA|PGP)\s+PRIVATE KEY-----/,
  },
];

function isExcluded(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  if (EXCLUDE_FILES.includes(normalized)) return true;
  if (EXCLUDE_DIRS.some((dir) => normalized === dir || normalized.startsWith(dir + '/'))) return true;
  return EXCLUDE_SEGMENTS.some((segment) => normalized.includes(segment.replace(/^\//, '')));
}

function listFiles() {
  if (SCAN_ALL) {
    const results = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(ROOT, full).replace(/\\/g, '/');
        if (isExcluded(rel)) continue;
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) results.push(rel);
      }
    };
    walk(ROOT);
    return results;
  }
  const args = STAGED
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z']
    : ['ls-files', '-z'];
  const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function shouldScan(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  const base = path.basename(relPath).toLowerCase();
  if (base === 'dockerfile' || base === 'makefile' || base === '.env' || base.startsWith('.env.')) return true;
  return SCAN_EXTS.has(ext);
}

function mask(value) {
  const text = String(value);
  if (text.length <= 8) return '*'.repeat(text.length);
  return text.slice(0, 6) + '***' + text.slice(-2);
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function scanFile(relPath, failures) {
  const full = path.join(ROOT, relPath);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return;

  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    return;
  }
  if (text.includes('\u0000')) return; // 二进制

  for (const rule of RULES) {
    const allow = rule.allow || [];
    if (allow.some((re) => re.test(relPath.replace(/\\/g, '/')))) continue;
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
    let match;
    while ((match = re.exec(text)) !== null) {
      failures.push({
        file: relPath,
        line: lineOf(text, match.index),
        rule: rule.id,
        desc: rule.desc,
        sample: mask(match[0]),
      });
      if (match.index === re.lastIndex) re.lastIndex++;
      if (failures.length > 500) return;
    }
  }
}

function main() {
  let files;
  try {
    files = listFiles();
  } catch (error) {
    console.error('[security-gate] 无法列出文件：', error.message);
    process.exit(2);
  }

  const failures = [];
  for (const rel of files) {
    if (isExcluded(rel) || !shouldScan(rel)) continue;
    scanFile(rel, failures);
  }

  if (failures.length === 0) {
    console.log(`[security-gate] 通过（扫描 ${files.length} 个文件）`);
    return;
  }

  console.error(`[security-gate] 命中 ${failures.length} 处敏感信息/不安全档位：\n`);
  for (const f of failures) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}] ${f.desc}  ->  ${f.sample}`);
  }
  console.error('\n处置：删除真实值、改用环境变量/密钥管理；确认是测试 fixture 的，移入 src/test 并加注释。');
  if (WARN_ONLY) {
    console.error('[security-gate] --warn-only：不阻断（仅告警）');
    return;
  }
  process.exitCode = 1;
}

module.exports = { RULES, isExcluded, shouldScan, scanFile };

if (require.main === module) {
  main();
}
