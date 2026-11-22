#!/usr/bin/env node
/**
 * test-config-examples.js —— 配置模板与 docker-compose 一致性门禁（P3 结构改进）
 *
 * 目的：防止 docker-compose 新增 ${VAR} 后忘记补 .env.example，导致干净部署
 * “按模板填完仍缺变量”。只检查 compose 引用的变量是否在模板中声明，不校验值。
 *
 * 用法：node tools/test-config-examples.js
 * 退出码：0 通过；1 缺项或模板自身不安全默认。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const COMPOSE = path.join(ROOT, 'backend/docker-compose.yml');
const ENV_EXAMPLE = path.join(ROOT, 'backend/deploy/.env.example');
const AI_EXAMPLE = path.join(ROOT, 'backend/deploy/.env.ai-service.example');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function declaredKeys(text) {
  const keys = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) keys.set(match[1], line);
  }
  return keys;
}

function composeVars(text) {
  const vars = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('#')) continue;
    for (const match of line.matchAll(/\${([A-Za-z_][A-Za-z0-9_]*)(?::[-?+][^}]*)?}/g)) {
      if (!vars.has(match[1])) vars.set(match[1], i + 1);
    }
  }
  return vars;
}

function main() {
  const failures = [];
  const compose = read(COMPOSE);
  const example = read(ENV_EXAMPLE);
  const declared = declaredKeys(example);
  const required = composeVars(compose);

  for (const [name, line] of required) {
    if (!declared.has(name)) failures.push(`.env.example 缺少 compose 引用变量 ${name}（compose 第 ${line} 行）`);
  }

  // L3 一致性：AI 加密开关与密钥模板必须成对出现在 compose 与 AI 专用模板。
  const ai = read(AI_EXAMPLE);
  if (!/AI_DEPLOY_ENV\s*=/.test(ai)) failures.push('.env.ai-service.example 缺少 AI_DEPLOY_ENV');
  if (!/AI_STORE_REQUIRE_ENCRYPTION\s*=\s*true/.test(ai)) {
    failures.push('.env.ai-service.example 的 AI_STORE_REQUIRE_ENCRYPTION 必须为 true');
  }
  if (!/AI_STORE_ENCRYPTION_KEY\s*=/.test(ai)) failures.push('.env.ai-service.example 缺少 AI_STORE_ENCRYPTION_KEY');
  if (!/AI_STORE_ENCRYPTION_KEY:\s*\${AI_STORE_ENCRYPTION_KEY:\?/.test(compose)) {
    failures.push('docker-compose.yml 的 AI_STORE_ENCRYPTION_KEY 必须用 ${VAR:?} 强制注入');
  }
  if (!/AI_STORE_REQUIRE_ENCRYPTION:\s*"true"/.test(compose)) {
    failures.push('docker-compose.yml 必须显式 AI_STORE_REQUIRE_ENCRYPTION=true');
  }
  if (!/AI_DEPLOY_ENV:\s*\${AI_DEPLOY_ENV:/.test(compose)) {
    failures.push('docker-compose.yml 缺少 AI_DEPLOY_ENV');
  }

  // L6（2026-11-23）：HIS mock 不得进入 compose / 部署模板默认值。
  if (/APP_HIS_MODE\s*[:=]\s*['"]?mock['"]?/im.test(compose)) {
    failures.push('docker-compose.yml 不得把 APP_HIS_MODE 设为 mock（生产禁止演示受理）');
  }
  if (/APP_HIS_MODE\s*=\s*['"]?mock['"]?/im.test(example)) {
    failures.push('.env.example 不得把 APP_HIS_MODE 设为 mock');
  }

  if (failures.length) {
    console.error(`[config-examples] 失败 ${failures.length} 项：`);
    for (const item of failures) console.error(`  - ${item}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[config-examples] 通过：compose ${required.size} 个变量均在 .env.example 声明；AI 加密模板与 compose 一致`);
}

main();
