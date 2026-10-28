// 실제 Gemini(챗봇 화면, 2026-10-28)가 PausePay 분석 질문에 낸 답을 normalize()에 통과시킨다 — 키 없이도 실제 모델 출력 형식과 맞는지 확인.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { normalize, parseJson, heuristic } = await import('../src/ai.js');
const dir = new URL('./real/', import.meta.url);
let ok = 0;
const test = (name, fn) => { try { fn(); ok++; console.log(`  ok   ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };
const load = (id) => JSON.parse(fs.readFileSync(new URL(`${id}.json`, dir), 'utf8'));

for (const [id, band] of [['pizza', ['allow']], ['concert', ['hold', 'block']], ['laptop', ['block']]]) {
  test(`실제 Gemini 답(${id}): JSON으로 읽히고 점수·신호·질문·대안이 채워지며 판정이 ${band.join('/')}`, () => {
    const n = normalize(parseJson(load(id).answer), 'gemini (web)', 'gemini-web');
    assert.ok(Number.isInteger(n.score) && n.score >= 0 && n.score <= 100);
    assert.ok(band.includes(n.verdict), `${id}: ${n.verdict} (${n.score})`);
    assert.ok(n.summary.length > 20 && n.warning.length > 10);
    assert.ok(n.signals.length >= 1 && n.questions.length >= 1);
    for (const s of n.signals) assert.ok(['low', 'medium', 'high'].includes(s.severity) && s.label && s.evidence);
  });
}
test('규칙 분석기는 실제 AI보다 낮아도 AI 점수를 낮추지 못한다(하한 규칙): 콘서트 사례에서 규칙 점수 ≤ AI 점수', () => {
  const c = load('concert');
  const ai = normalize(parseJson(c.answer), 'gemini (web)', 'gemini-web');
  const rules = heuristic({ context: 'Seller: I only have 2 tickets left, face value. Pay within 2 hours by Friends & Family or I sell them to the next person in line.', amount: 240 });
  assert.ok(rules.risk_score <= ai.score);
});
console.log(`\n${ok} real-model test(s) passed${process.exitCode ? ' — with failures' : ''}`);
