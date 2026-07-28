// 모델 패밀리 카탈로그 헬퍼 — Composer의 모델 피커가 쓰는 순수 로직을 분리한 모듈.
// (JSX 없는 순수 JS라 node --test에서 직접 import해 회귀 테스트할 수 있다.)
// claude.ai 모델 피커를 본딴 카탈로그 — 표시 이름·설명은 claude.ai 서비스 문구 기준,
// 전송 value·버전은 CLI initialize의 실측 목록(value/resolvedModel)에서 취한다.
// fallbackVersion은 CLI 카탈로그에 매칭 항목이 없거나 resolvedModel 파싱이 실패할 때만
// 쓰이는 표시용 — 2026-07 Opus 5(claude-opus-5) 출시에 맞춰 opus는 '5'.
export const MODEL_FAMILIES = [
  { family: 'haiku', name: 'Haiku', fallbackValue: 'haiku', fallbackVersion: '4.5', desc: '빠른 응답이 필요한 가벼운 작업에 최적' },
  { family: 'sonnet', name: 'Sonnet', fallbackValue: 'sonnet', fallbackVersion: '5', desc: '일상 업무를 위한 똑똑하고 효율적인 모델' },
  { family: 'opus', name: 'Opus', fallbackValue: 'opus', fallbackVersion: '5', desc: '복잡한 과제를 위한 강력한 대형 모델' },
  { family: 'fable', name: 'Fable', fallbackValue: 'claude-fable-5', fallbackVersion: '5', desc: '가장 어렵고 긴 작업을 위한 최고 성능 모델' },
];

export function parseVersion(resolvedModel) {
  const m = /claude-[a-z]+-(\d+)(?:-(\d+))?/.exec(String(resolvedModel ?? ''));
  if (!m) return null;
  return m[2] ? `${m[1]}.${m[2]}` : m[1];
}

export function familyOf(model) {
  const s = String(model ?? '').toLowerCase();
  return MODEL_FAMILIES.find((f) => s.includes(f.family)) ?? null;
}

export function buildModelOptions(models) {
  return MODEL_FAMILIES.map((f) => {
    const entry = models.find(
      (m) =>
        m.value !== 'default' &&
        `${m.resolvedModel ?? ''} ${m.value ?? ''} ${m.displayName ?? ''}`.toLowerCase().includes(f.family),
    );
    return {
      ...f,
      value: entry?.value ?? f.fallbackValue,
      version: parseVersion(entry?.resolvedModel) ?? f.fallbackVersion,
      cliEntry: entry ?? null,
    };
  });
}
