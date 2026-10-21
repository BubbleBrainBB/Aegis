import assert from 'node:assert/strict';

/**
 * Question-card answers reach every agent with option labels and the user's
 * own text intact, also when either contains a comma. The card sends
 * `questionAnswers` (structured); callers that only send the comma-joined
 * `answers` string (the phone) are split with whole labels matched first.
 */

async function main(): Promise<void> {
  const { resolveQuestionAnswer, splitJoinedAnswer, questionAnswerValues } = await import('../../src/shared/question-answers');
  const { kimiQuestionAnswers } = await import('../../src/electron/libs/provider/kimi-questions');
  const { buildQuestionAnswers } = await import('../../src/electron/libs/provider/bubble-sdk-adapter');
  const { buildOpenCodeFormAnswer } = await import('../../src/electron/libs/provider/opencode-sdk-adapter');
  const { CodexAppServerManager } = await import('../../src/electron/libs/provider/codex-app-server-manager');

  const labels = ['Paris, France', 'Tokyo'];
  const question = 'Cities?';
  const structured = {
    behavior: 'allow' as const,
    updatedInput: { answers: { [question]: 'Paris, France,Tokyo,Lyon, maybe' } },
    questionAnswers: { [question]: { selected: ['Paris, France', 'Tokyo'], other: 'Lyon, maybe' } },
  };
  const joinedOnly = { behavior: 'allow' as const, updatedInput: { answers: { [question]: 'Paris, France,Tokyo,Lyon, maybe' } } };
  const expected = { selected: ['Paris, France', 'Tokyo'], other: 'Lyon, maybe' };

  // ── The shared resolver ───────────────────────────────────────────────────
  assert.deepEqual(resolveQuestionAnswer(structured, question, labels), expected, 'structured answers are used as given');
  assert.deepEqual(resolveQuestionAnswer(joinedOnly, question, labels), expected, 'the joined string splits on whole labels');
  assert.deepEqual(
    resolveQuestionAnswer({ updatedInput: { answers: { [question]: 'Lyon, maybe' } }, questionAnswers: { [question]: { selected: [], other: 'x' } } }, question, labels),
    { selected: [], other: 'x' },
    'structured wins over a disagreeing joined string'
  );
  assert.deepEqual(
    resolveQuestionAnswer({ questionAnswers: { [question]: { selected: ['Berlin'] } } }, question, labels),
    { selected: [], other: 'Berlin' },
    'a label the agent did not list counts as the user’s text'
  );
  assert.deepEqual(resolveQuestionAnswer({}, question, labels), { selected: [], other: '' });
  assert.deepEqual(splitJoinedAnswer('tokyo,PARIS, FRANCE', labels, { ignoreCase: true }), { selected: ['Tokyo', 'Paris, France'], other: '' });
  assert.deepEqual(splitJoinedAnswer('Paris, Franceville', labels), { selected: [], other: 'Paris, Franceville' }, 'a label must end at a comma');
  assert.deepEqual(splitJoinedAnswer('Tokyo,Tokyo', labels), { selected: ['Tokyo'], other: '' }, 'a repeated pick counts once');
  assert.deepEqual(questionAnswerValues(expected), ['Paris, France', 'Tokyo', 'Lyon, maybe']);

  for (const [name, decision] of [['structured', structured], ['joined string', joinedOnly]] as const) {
    // ── Kimi: labels → option ids; free text when allowed ──────────────────
    const kimi = kimiQuestionAnswers(
      [{ id: 'q1', question, options: [{ id: 'paris', label: 'Paris, France' }, { id: 'tokyo', label: 'Tokyo' }], multiSelect: true, allowOther: true }],
      decision
    );
    assert.deepEqual(kimi, { q1: { kind: 'multi_with_other', option_ids: ['paris', 'tokyo'], other_text: 'Lyon, maybe' } }, `Kimi (${name})`);

    // ── Bubble: picked labels, then the user's text ───────────────────────
    const bubble = buildQuestionAnswers(
      [{ header: 'City', question, options: labels.map((label) => ({ label, description: '' })), multiple: true }],
      decision
    );
    assert.deepEqual(bubble, [['Paris, France', 'Tokyo', 'Lyon, maybe']], `Bubble (${name})`);

    // ── OpenCode: labels → form values ────────────────────────────────────
    const form = buildOpenCodeFormAnswer(
      [{ key: 'cities', question, type: 'multiselect', options: [{ label: 'Paris, France', value: 'paris' }, { label: 'Tokyo', value: 'tokyo' }] }],
      decision
    );
    assert.deepEqual(form, { cities: ['paris', 'tokyo', 'Lyon, maybe'] }, `OpenCode (${name})`);

    // ── Codex app-server: answers per question id ─────────────────────────
    const manager = Object.create(CodexAppServerManager.prototype) as {
      buildToolUserInputResponse: (params: Record<string, unknown>, result: unknown) => Record<string, unknown>;
    };
    const codex = manager.buildToolUserInputResponse(
      { questions: [{ id: 'cities', question, options: labels.map((label) => ({ label })) }] },
      decision
    );
    assert.deepEqual(codex, { answers: { cities: { answers: ['Paris, France', 'Tokyo', 'Lyon, maybe'] } } }, `Codex (${name})`);
  }

  // OpenCode single choice: the picked option, whole.
  assert.deepEqual(
    buildOpenCodeFormAnswer(
      [{ key: 'city', question, type: 'select', options: [{ label: 'Paris, France', value: 'paris' }, { label: 'Tokyo', value: 'tokyo' }] }],
      { behavior: 'allow', questionAnswers: { [question]: { selected: ['Paris, France'] } } }
    ),
    { city: 'paris' }
  );
  // Codex: an answer keyed by question id (older callers) still resolves.
  const manager = Object.create(CodexAppServerManager.prototype) as {
    buildToolUserInputResponse: (params: Record<string, unknown>, result: unknown) => Record<string, unknown>;
  };
  assert.deepEqual(
    manager.buildToolUserInputResponse(
      { questions: [{ id: 'cities', question, options: labels.map((label) => ({ label })) }] },
      { behavior: 'allow', updatedInput: { answers: { cities: 'Tokyo' } } }
    ),
    { answers: { cities: { answers: ['Tokyo'] } } }
  );

  console.log('question-answers: structured and joined answers, Kimi, Bubble, OpenCode and Codex passed');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
