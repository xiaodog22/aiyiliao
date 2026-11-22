#!/usr/bin/env node
/** 安全默认值规则回归（P3）：用合成样例证明 H1/M10/L6 真能命中，且安全写法不误报。 */
'use strict';

const { RULES } = require('./security-gate');

function rule(id) {
  const found = RULES.find((item) => item.id === id);
  if (!found) throw new Error(`security-gate 缺少规则 ${id}`);
  return found.re;
}

function hits(id, text) {
  const re = new RegExp(rule(id).source, rule(id).flags.replace(/g/g, ''));
  return re.test(text);
}

const cases = [
  ['H1-SMS-FAIL-OPEN', '@ConditionalOnProperty(name = "app.sms.provider", havingValue = "dev", matchIfMissing = true)', true],
  ['H1-SMS-FAIL-OPEN', '说明文字：matchIfMissing=true 是危险默认，但是这里只是注释', false],
  ['H1-SMS-FAIL-OPEN', '@ConditionalOnProperty(name = "app.sms.provider", havingValue = "dev", matchIfMissing = false)', false],
  ['M10-DEMO-ACCOUNT', '13900139001,doc123', true],
  ['M10-DEMO-ACCOUNT', '13900139001,doctor01', false],
  ['M10-MOCK-DOCTOR', "role: 'DOCTOR', password: 'doc123'", true],
  ['L6-HIS-MOCK-FAIL-OPEN', 'app:\n  his:\n    mode: mock\n', true],
  ['L6-HIS-MOCK-FAIL-OPEN', 'app:\n  his:\n    mode: http\n', false],
  ['L6-HIS-MODE-ENV-MOCK', 'APP_HIS_MODE=mock\n', true],
  ['L6-HIS-MODE-ENV-MOCK', 'APP_HIS_MODE=mock # 仅测试\n', true],
  ['L6-HIS-MODE-ENV-MOCK', 'APP_HIS_MODE=disabled\n', false],
  ['H3-AUTH-OFF', 'APP_AUTH_MODE=off\n', true],
  ['H3-AUTH-OFF', '# APP_AUTH_MODE=off 只是说明\n', false],
  ['H7-WEAK-DB-PASSWORD', 'MYSQL_ROOT_PASSWORD: local_root', true],
  ['H7-WEAK-DB-PASSWORD', 'MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:?必须注入}', false],
  ['M5-DEV-SIGN-SECRET', 'secret = "local-only-sign-secret-please-change"', true],
  ['H9-BUILD-ENV-DEV', "const BUILD_ENV = 'development'", true],
];

let failed = 0;
for (const [id, text, expected] of cases) {
  const actual = hits(id, text);
  if (actual !== expected) {
    failed++;
    console.error(`  [FAIL] ${id} 期望 ${expected}，实际 ${actual}：${JSON.stringify(text)}`);
  }
}
if (failed) {
  console.error(`[security-defaults] 失败 ${failed} 项`);
  process.exitCode = 1;
} else {
  console.log(`[security-defaults] 通过：${cases.length} 条合成样例（fail-open / 默认口令 / mock 默认均命中）`);
}
