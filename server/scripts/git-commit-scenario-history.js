/**
 * 시나리오 실행으로 바뀐 문서만 stage → commit → push
 * - 프로젝트 루트 = server/ 상위 폴더
 *
 * 푸시 생략: $env:SCENARIO_GIT_NO_PUSH='1'   (PowerShell)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

const TE_SCENARIO = path.join('docs', '80. 프로젝트 테스트(TE)', '테스트시나리오');
const TO_ADD = [
  path.join(TE_SCENARIO, '시나리오-실행이력'),
  path.join(TE_SCENARIO, 'API-통합-시나리오-실행-통합대장.md'),
];

function shInherit(cmd) {
  execSync(cmd, { cwd: PROJECT_ROOT, stdio: 'inherit', env: process.env });
}

function sh(cmd) {
  return execSync(cmd, { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function main() {
  if (!fs.existsSync(path.join(PROJECT_ROOT, '.git'))) {
    console.error('[scenario:git] Git 저장소가 아닙니다:', PROJECT_ROOT);
    process.exit(1);
  }

  for (const rel of TO_ADD) {
    const full = path.join(PROJECT_ROOT, rel);
    if (!fs.existsSync(full)) {
      console.warn('[scenario:git] 경고: 없음 (스킵):', rel);
      continue;
    }
    const posixRel = rel.split(path.sep).join('/');
    shInherit(`git add -- ${JSON.stringify(posixRel)}`);
  }

  let status;
  try {
    status = sh('git status --porcelain -- "docs/80. 프로젝트 테스트(TE)/테스트시나리오/"');
  } catch (e) {
    console.error('[scenario:git] git status 실패:', e.message);
    process.exit(1);
  }

  if (!status.trim()) {
    console.log('[scenario:git] 커밋할 변경 없음.');
    process.exit(0);
  }

  const msg = `chore(test): 시나리오 실행 이력 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
  try {
    shInherit(`git commit -m ${JSON.stringify(msg)}`);
  } catch {
    console.error('[scenario:git] commit 실패 (변경 없음·또는 user.name/email 미설정)');
    process.exit(1);
  }

  if (process.env.SCENARIO_GIT_NO_PUSH === '1' || process.env.SCENARIO_GIT_NO_PUSH === 'true') {
    console.log('[scenario:git] SCENARIO_GIT_NO_PUSH → push 생략');
    process.exit(0);
  }

  try {
    shInherit('git push');
  } catch {
    console.error('[scenario:git] push 실패 — remote·브랜치·로그인 확인');
    process.exit(1);
  }
  console.log('[scenario:git] push 완료');
}

main();
