const STORAGE_KEY = "daqh_quiz_progress_v1";
const CLIENT_ID_KEY = "daqh_quiz_client_id_v1";
const SYNC_TABLE = "quiz_sync_states";

const CATEGORIES = [
  { id: "all", title: "全部试题", className: "card-all" },
  { id: "laws", title: "行业重要法规与准则", className: "card-laws" },
  { id: "policy", title: "行业重要政策性文件", className: "card-policy" },
  { id: "ethics", title: "行业史与职业道德", className: "card-ethics" },
  { id: "cram", title: "机考冲刺", className: "card-cram" },
];

const TYPE_LABELS = {
  single: "单选题",
  multiple: "多选题",
  judge: "判断题",
};

const questions = Array.isArray(window.QUESTION_BANK) ? window.QUESTION_BANK : [];

let state = loadState();
let sessionQuestions = [];
let currentIndex = 0;
let selectedAnswers = new Set();
let submitted = false;
let mistakeQuestions = [];
let mistakeIndex = 0;
let mistakeSelectedAnswers = new Set();
let mistakeSubmitted = false;
const noteSaveTimers = new Map();
const NOTE_SAVE_DELAY = 400;
let supabaseClient = null;
let syncSession = null;
let syncSaveTimer = null;
let syncPulling = false;
let lastSyncMessage = "";

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getEmptyState();
    return normalizeState({ ...getEmptyState(), ...JSON.parse(raw) });
  } catch {
    return getEmptyState();
  }
}

function getEmptyState() {
  return {
    total: 0,
    correct: 0,
    wrong: 0,
    clientId: getOrCreateClientId(),
    statsByClient: {},
    mistakes: {},
    records: [],
    notes: {},
    meta: {
      updatedAt: null,
      resetAt: null,
      mistakesClearedAt: null,
      removedMistakes: {},
      deletedNotes: {},
    },
  };
}

function normalizeState(nextState) {
  const empty = getEmptyState();
  const clientId = typeof nextState.clientId === "string" && nextState.clientId
    ? nextState.clientId
    : empty.clientId;
  const meta = normalizeMeta(nextState.meta);
  const statsByClient = normalizeStatsByClient(nextState.statsByClient, clientId, nextState);
  const records = Array.isArray(nextState.records)
    ? nextState.records.map((record) => normalizeRecord(record, clientId)).filter(Boolean)
    : empty.records;

  const normalized = {
    total: Number.isFinite(Number(nextState.total)) ? Number(nextState.total) : empty.total,
    correct: Number.isFinite(Number(nextState.correct)) ? Number(nextState.correct) : empty.correct,
    wrong: Number.isFinite(Number(nextState.wrong)) ? Number(nextState.wrong) : empty.wrong,
    clientId,
    statsByClient,
    mistakes: isPlainObject(nextState.mistakes) ? nextState.mistakes : empty.mistakes,
    records,
    notes: isPlainObject(nextState.notes) ? nextState.notes : empty.notes,
    meta,
  };
  normalizeMistakeTimes(normalized);
  normalizeNoteTimes(normalized);
  return recomputeStats(normalized);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function saveState(options = {}) {
  const { touch = true, sync = true } = options;
  if (touch) touchState();
  state = recomputeStats(normalizeState(state));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (sync) scheduleCloudSave();
}

function touchState(time = new Date().toISOString()) {
  state.meta.updatedAt = time;
}

function getOrCreateClientId() {
  try {
    const existing = localStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const next = createId("client");
    localStorage.setItem(CLIENT_ID_KEY, next);
    return next;
  } catch {
    return createId("client");
  }
}

function createId(prefix) {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return `${prefix}-${window.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeMeta(meta) {
  const source = isPlainObject(meta) ? meta : {};
  return {
    updatedAt: normalizeIso(source.updatedAt),
    resetAt: normalizeIso(source.resetAt),
    mistakesClearedAt: normalizeIso(source.mistakesClearedAt),
    removedMistakes: normalizeTimestampMap(source.removedMistakes),
    deletedNotes: normalizeTimestampMap(source.deletedNotes),
  };
}

function normalizeTimestampMap(value) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, time]) => [key, normalizeIso(time)])
      .filter(([, time]) => time)
  );
}

function normalizeStatsByClient(statsByClient, clientId, sourceState) {
  const stats = {};
  if (isPlainObject(statsByClient)) {
    Object.entries(statsByClient).forEach(([id, item]) => {
      if (!isPlainObject(item)) return;
      stats[id] = {
        total: toNonNegativeInt(item.total),
        correct: toNonNegativeInt(item.correct),
        wrong: toNonNegativeInt(item.wrong),
        updatedAt: normalizeIso(item.updatedAt) || normalizeIso(sourceState.meta?.updatedAt),
      };
    });
  }

  if (!Object.keys(stats).length) {
    const total = toNonNegativeInt(sourceState.total);
    const correct = toNonNegativeInt(sourceState.correct);
    const wrong = toNonNegativeInt(sourceState.wrong);
    if (total || correct || wrong) {
      stats[clientId] = {
        total,
        correct,
        wrong,
        updatedAt: normalizeIso(sourceState.meta?.updatedAt) || inferStateUpdatedAt(sourceState),
      };
    }
  }
  return stats;
}

function inferStateUpdatedAt(sourceState) {
  const times = [];
  if (Array.isArray(sourceState.records)) {
    sourceState.records.forEach((record) => {
      const time = normalizeIso(record?.time);
      if (time) times.push(time);
    });
  }
  if (isPlainObject(sourceState.mistakes)) {
    Object.values(sourceState.mistakes).forEach((mistake) => {
      const time = normalizeIso(mistake?.time);
      if (time) times.push(time);
    });
  }
  if (isPlainObject(sourceState.notes)) {
    Object.values(sourceState.notes).forEach((note) => {
      const time = normalizeIso(note?.updatedAt);
      if (time) times.push(time);
    });
  }
  return times.sort().pop() || null;
}

function normalizeRecord(record, clientId) {
  if (!isPlainObject(record) || !record.questionId) return null;
  const time = normalizeIso(record.time) || new Date().toISOString();
  const normalizedClientId = typeof record.clientId === "string" && record.clientId ? record.clientId : clientId;
  return {
    id: typeof record.id === "string" && record.id
      ? record.id
      : `legacy-${normalizedClientId}-${record.questionId}-${record.selected || ""}-${time}`,
    clientId: normalizedClientId,
    questionId: record.questionId,
    selected: record.selected || "",
    answer: record.answer || "",
    correct: Boolean(record.correct),
    time,
  };
}

function normalizeMistakeTimes(nextState) {
  Object.entries(nextState.mistakes).forEach(([questionId, mistake]) => {
    if (!isPlainObject(mistake)) {
      delete nextState.mistakes[questionId];
      return;
    }
    mistake.questionId = mistake.questionId || questionId;
    mistake.time = normalizeIso(mistake.time) || nextState.meta.updatedAt || new Date().toISOString();
  });
}

function normalizeNoteTimes(nextState) {
  Object.entries(nextState.notes).forEach(([questionId, note]) => {
    if (!isPlainObject(note) || typeof note.text !== "string") {
      delete nextState.notes[questionId];
      return;
    }
    note.updatedAt = normalizeIso(note.updatedAt) || nextState.meta.updatedAt || new Date().toISOString();
  });
}

function recomputeStats(nextState) {
  const totals = Object.values(nextState.statsByClient).reduce((sum, item) => {
    sum.total += toNonNegativeInt(item.total);
    sum.correct += toNonNegativeInt(item.correct);
    sum.wrong += toNonNegativeInt(item.wrong);
    return sum;
  }, { total: 0, correct: 0, wrong: 0 });

  nextState.total = totals.total;
  nextState.correct = totals.correct;
  nextState.wrong = totals.wrong;
  return nextState;
}

function toNonNegativeInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function normalizeIso(value) {
  if (!value) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

function maxIso(...values) {
  return values.filter(Boolean).sort().pop() || null;
}

function isAfter(left, right) {
  if (!left) return false;
  if (!right) return true;
  return left > right;
}

function byId(id) {
  return document.getElementById(id);
}

function getQuestionById(id) {
  return questions.find((question) => question.id === id);
}

function getCategoryCount(categoryId) {
  if (categoryId === "all") return questions.length;
  return questions.filter((question) => questionMatchesCategory(question, categoryId)).length;
}

function questionMatchesCategory(question, categoryId) {
  return question.category === categoryId || (question.tags || []).includes(categoryId);
}

function getFilteredQuestions() {
  const category = byId("category-select").value;
  const type = byId("type-select").value;
  const status = byId("status-select").value;
  return questions.filter((question) => {
    const categoryMatch = category === "all" || questionMatchesCategory(question, category);
    const typeMatch = type === "all" || question.type === type;
    const statusMatch = status === "all" || getQuestionStatus(question).key === status;
    return categoryMatch && typeMatch && statusMatch;
  });
}

function getLatestRecordByQuestionId(questionId) {
  return state.records
    .filter((record) => record.questionId === questionId)
    .sort((a, b) => b.time.localeCompare(a.time))[0] || null;
}

function getQuestionStatus(question) {
  const latestRecord = getLatestRecordByQuestionId(question.id);
  if (!latestRecord) {
    return { key: "unanswered", label: "未刷" };
  }
  return latestRecord.correct
    ? { key: "correct", label: "最近答对" }
    : { key: "wrong", label: "最近答错" };
}

function getProgressSummary(questionList) {
  const answered = questionList.filter((question) => getLatestRecordByQuestionId(question.id)).length;
  return {
    total: questionList.length,
    answered,
    unanswered: questionList.length - answered,
  };
}

function renderQuestionStatusBadge(question) {
  const status = getQuestionStatus(question);
  return `<span class="badge status-badge status-${status.key}" data-question-status="${escapeHtml(question.id)}">${status.label}</span>`;
}

function updateVisibleQuestionStatusBadges() {
  document.querySelectorAll("[data-question-status]").forEach((badge) => {
    const question = getQuestionById(badge.dataset.questionStatus);
    if (!question) return;
    const status = getQuestionStatus(question);
    badge.className = `badge status-badge status-${status.key}`;
    badge.textContent = status.label;
  });
}

function updateProgressDisplays() {
  renderCategories();
  updatePoolCount();
  updateVisibleQuestionStatusBadges();
}

function updateStats() {
  const rate = state.total ? Math.round((state.correct / state.total) * 100) : 0;
  byId("stat-total").textContent = String(state.total);
  byId("stat-correct").textContent = String(state.correct);
  byId("stat-wrong").textContent = String(state.wrong);
  byId("stat-rate").textContent = `${rate}%`;
}

function showView(viewName) {
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === `view-${viewName}`);
  });
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === viewName);
  });
  if (viewName === "mistakes") renderMistakes();
  if (viewName === "records") renderRecords();
}

function renderCategories() {
  const grid = byId("category-grid");
  grid.innerHTML = CATEGORIES.map((category) => {
    const count = getCategoryCount(category.id);
    const progress = getProgressSummary(
      questions.filter((question) => category.id === "all" || questionMatchesCategory(question, category.id))
    );
    return `
      <button class="category-card ${category.className}" data-category="${category.id}">
        <strong>${category.title}</strong>
        <span>开始练习</span>
        <small>已刷 ${progress.answered} / ${count} 题</small>
      </button>
    `;
  }).join("");

  grid.querySelectorAll(".category-card").forEach((card) => {
    card.addEventListener("click", () => {
      byId("category-select").value = card.dataset.category;
      byId("type-select").value = "all";
      byId("status-select").value = "all";
      startPractice(false);
      showView("practice");
    });
  });
}

function renderSelectors() {
  byId("category-select").innerHTML = CATEGORIES.map((category) => {
    return `<option value="${category.id}">${category.title}（${getCategoryCount(category.id)}题）</option>`;
  }).join("");

  byId("category-select").addEventListener("change", updatePoolCount);
  byId("type-select").addEventListener("change", updatePoolCount);
  byId("status-select").addEventListener("change", updatePoolCount);
  updatePoolCount();
}

function updatePoolCount() {
  const progress = getProgressSummary(getFilteredQuestions());
  byId("pool-count").textContent = `共 ${progress.total} 题 · 已刷 ${progress.answered} 题 · 未刷 ${progress.unanswered} 题`;
}

function startPractice(shuffle) {
  sessionQuestions = getFilteredQuestions();
  if (shuffle) {
    sessionQuestions = [...sessionQuestions].sort(() => Math.random() - 0.5);
  }
  currentIndex = 0;
  resetAnswerState();
  renderQuestion();
  updatePoolCount();
}

function resetAnswerState() {
  selectedAnswers = new Set();
  submitted = false;
}

function renderQuestion() {
  const card = byId("question-card");
  byId("current-progress").textContent = `第 ${sessionQuestions.length ? currentIndex + 1 : 0} / ${sessionQuestions.length} 题`;

  if (!sessionQuestions.length) {
    card.innerHTML = `
      <div class="empty-state">
        <h2>当前筛选没有题目</h2>
        <p>换一个分类或题型试试。</p>
      </div>
    `;
    return;
  }

  const question = sessionQuestions[currentIndex];
  card.innerHTML = renderQuestionContent(question, {
    answerPanelId: "answer-panel",
    actionsHtml: `
      <button class="primary-btn" id="submit-answer">提交答案</button>
      <button class="ghost-btn" id="prev-question">上一题</button>
      <button class="ghost-btn" id="next-question">下一题</button>
    `,
  });

  card.querySelectorAll(".option").forEach((button) => {
    button.addEventListener("click", () => toggleAnswer(button.dataset.answer));
  });
  byId("submit-answer").addEventListener("click", submitAnswer);
  byId("prev-question").addEventListener("click", () => moveQuestion(-1));
  byId("next-question").addEventListener("click", () => moveQuestion(1));
}

function getQuestionOptions(question) {
  if (question.type === "judge" && question.options.length === 0) {
    return [
      { key: "正确", text: "正确" },
      { key: "错误", text: "错误" },
    ];
  }
  return question.options;
}

function renderQuestionContent(question, options = {}) {
  const { answerPanelId, actionsHtml } = options;
  return `
    <div class="question-meta">
      <span class="badge">${escapeHtml(question.categoryTitle)}</span>
      <span class="badge">${escapeHtml(TYPE_LABELS[question.type] || "题目")}</span>
      <span class="badge">${escapeHtml(question.sourceFile)}</span>
      ${renderQuestionStatusBadge(question)}
    </div>
    <h2 class="question-title">${escapeHtml(question.section || "练习题")}</h2>
    <div class="question-stem">${escapeHtml(question.stem)}</div>
    <div class="options">
      ${getQuestionOptions(question).map((option) => `
        <button class="option" data-answer="${escapeHtml(option.key)}">
          <span class="option-key">${escapeHtml(option.key)}</span>
          <span>${escapeHtml(option.text)}</span>
        </button>
      `).join("")}
    </div>
    <div class="answer-panel" id="${escapeHtml(answerPanelId)}"></div>
    <div class="question-actions">
      ${actionsHtml}
    </div>
  `;
}

function toggleAnswer(answer) {
  if (submitted) return;
  const question = sessionQuestions[currentIndex];
  selectedAnswers = updateSelectedAnswers(question, selectedAnswers, answer);
  markSelectedOptions(byId("question-card"), selectedAnswers);
}

function updateSelectedAnswers(question, currentAnswers, answer) {
  const nextAnswers = new Set(currentAnswers);
  if (question.type === "multiple") {
    if (nextAnswers.has(answer)) nextAnswers.delete(answer);
    else nextAnswers.add(answer);
    return nextAnswers;
  }
  return new Set([answer]);
}

function markSelectedOptions(root, selectedSet) {
  root.querySelectorAll(".option").forEach((button) => {
    button.classList.toggle("selected", selectedSet.has(button.dataset.answer));
  });
}

function normalizeAnswer(value) {
  if (!value) return "";
  if (value === "正确" || value === "错误") return value;
  if (value === "对") return "正确";
  if (value === "错") return "错误";
  return value
    .split("")
    .filter(Boolean)
    .sort()
    .join("");
}

function getSelectedAnswerText() {
  return [...selectedAnswers].sort().join("");
}

function submitAnswer() {
  if (submitted) return;
  const question = sessionQuestions[currentIndex];
  if (!selectedAnswers.size) {
    showAnswerNotice(byId("answer-panel"), "请先选择答案。");
    return;
  }

  submitted = true;
  const selected = getSelectedAnswerText();
  const isCorrect = normalizeAnswer(selected) === normalizeAnswer(question.answer);
  recordAnswer(question, selected, isCorrect);
  markOptions(question, selected, byId("question-card"));
  renderAnswerPanel(question, selected, isCorrect, byId("answer-panel"));
}

function recordAnswer(question, selected, isCorrect) {
  const now = new Date().toISOString();
  const clientStats = state.statsByClient[state.clientId] || {
    total: 0,
    correct: 0,
    wrong: 0,
    updatedAt: null,
  };

  clientStats.total += 1;
  if (isCorrect) {
    clientStats.correct += 1;
  } else {
    clientStats.wrong += 1;
    state.mistakes[question.id] = {
      questionId: question.id,
      selected,
      answer: question.answer,
      time: now,
    };
  }
  clientStats.updatedAt = now;
  state.statsByClient[state.clientId] = clientStats;

  state.records.unshift({
    id: createId("record"),
    clientId: state.clientId,
    questionId: question.id,
    selected,
    answer: question.answer,
    correct: isCorrect,
    time: now,
  });
  state.records = state.records.slice(0, 300);

  saveState();
  updateStats();
  updateProgressDisplays();
}

function showAnswerNotice(panel, message) {
  panel.className = "answer-panel show";
  panel.textContent = message;
}

function markOptions(question, selected, root = document) {
  const correctSet = getAnswerSet(question, question.answer);
  const selectedSet = getAnswerSet(question, selected);
  root.querySelectorAll(".option").forEach((button) => {
    const value = button.dataset.answer;
    if (correctSet.has(value)) button.classList.add("correct");
    if (selectedSet.has(value) && !correctSet.has(value)) button.classList.add("wrong");
  });
}

function getAnswerSet(question, value) {
  const normalized = normalizeAnswer(value);
  if (question.type === "judge") return new Set([normalized]);
  return new Set(normalized.split(""));
}

function renderAnswerPanel(question, selected, isCorrect, panel = byId("answer-panel")) {
  panel.className = "answer-panel show";
  panel.innerHTML = `
    <div class="answer-summary">
      <strong>${isCorrect ? "回答正确" : "回答错误"}</strong>
      <p>你的答案：${escapeHtml(selected)}</p>
      <p>正确答案：${escapeHtml(question.answer)}</p>
    </div>
    <div class="official-explanation">
      <strong>官方解析</strong>
      <p>${escapeHtml(question.explanation || "暂无解析。")}</p>
    </div>
    ${renderNoteEditor(question.id)}
  `;
  bindNoteEditors(panel);
}

function getNoteText(questionId) {
  const note = state.notes[questionId];
  return note && typeof note.text === "string" ? note.text : "";
}

function saveNote(questionId, text) {
  if (!isPlainObject(state.notes)) state.notes = {};
  const now = new Date().toISOString();
  if (text.trim()) {
    state.notes[questionId] = {
      text,
      updatedAt: now,
    };
    delete state.meta.deletedNotes[questionId];
  } else {
    delete state.notes[questionId];
    state.meta.deletedNotes[questionId] = now;
  }
  saveState();
}

function renderNoteEditor(questionId) {
  const text = getNoteText(questionId);
  return `
    <section class="note-editor">
      <div class="note-editor-header">
        <strong>我的补充解析（选填）</strong>
        <span class="note-status">${text ? "已加载本地解析" : "输入后自动保存"}</span>
      </div>
      <textarea
        data-note-question-id="${escapeHtml(questionId)}"
        rows="4"
        placeholder="可选：写下你自己的理解、易错点或记忆提示。"
      >${escapeHtml(text)}</textarea>
    </section>
  `;
}

function bindNoteEditors(root) {
  root.querySelectorAll("[data-note-question-id]").forEach((textarea) => {
    textarea.addEventListener("input", () => {
      const questionId = textarea.dataset.noteQuestionId;
      const status = textarea.closest(".note-editor")?.querySelector(".note-status");
      const oldTimer = noteSaveTimers.get(textarea);
      if (oldTimer) clearTimeout(oldTimer);
      if (status) status.textContent = "正在保存...";

      const timer = setTimeout(() => {
        saveNote(questionId, textarea.value);
        syncNoteEditors(questionId, textarea.value, textarea);
        if (status) status.textContent = textarea.value.trim() ? "已自动保存" : "已清空";
        noteSaveTimers.delete(textarea);
      }, NOTE_SAVE_DELAY);
      noteSaveTimers.set(textarea, timer);
    });
  });
}

function clearNoteSaveTimers() {
  noteSaveTimers.forEach((timer) => clearTimeout(timer));
  noteSaveTimers.clear();
}

function syncNoteEditors(questionId, text, sourceTextarea) {
  document.querySelectorAll("[data-note-question-id]").forEach((textarea) => {
    if (textarea === sourceTextarea || textarea.dataset.noteQuestionId !== questionId) return;
    textarea.value = text;
    const status = textarea.closest(".note-editor")?.querySelector(".note-status");
    if (status) status.textContent = text.trim() ? "已同步本地解析" : "已清空";
  });
}

function moveQuestion(step) {
  if (!sessionQuestions.length) return;
  currentIndex = Math.min(Math.max(currentIndex + step, 0), sessionQuestions.length - 1);
  resetAnswerState();
  renderQuestion();
}

function resetMistakeAnswerState() {
  mistakeSelectedAnswers = new Set();
  mistakeSubmitted = false;
}

function renderMistakes() {
  const card = byId("mistake-card");
  const progress = byId("mistake-progress");
  renderMistakeCategoryOptions();
  mistakeQuestions = getFilteredMistakeQuestions();
  if (mistakeIndex >= mistakeQuestions.length) mistakeIndex = Math.max(mistakeQuestions.length - 1, 0);
  if (progress) {
    progress.textContent = `第 ${mistakeQuestions.length ? mistakeIndex + 1 : 0} / ${mistakeQuestions.length} 题`;
  }

  if (!mistakeQuestions.length) {
    const categorySelect = byId("mistake-category-select");
    const hasAnyMistakes = getMistakeQuestions().length > 0;
    card.innerHTML = `
      <div class="empty-state">
        <h2>${hasAnyMistakes ? "当前分类暂无错题" : "暂无错题"}</h2>
        <p>${hasAnyMistakes ? "换一个分类继续复习。" : "保持这个状态，很漂亮。"}</p>
      </div>
    `;
    if (categorySelect) categorySelect.disabled = !hasAnyMistakes;
    return;
  }

  const question = mistakeQuestions[mistakeIndex];
  const mistake = state.mistakes[question.id];
  const lastTime = mistake?.time ? new Date(mistake.time).toLocaleDateString("zh-CN") : "";
  card.innerHTML = `
    ${renderQuestionContent(question, {
      answerPanelId: "mistake-answer-panel",
      actionsHtml: `
        <button class="primary-btn" id="master-mistake">标记已掌握</button>
        <button class="ghost-btn" id="prev-mistake">上一题</button>
        <button class="primary-btn" id="submit-mistake-answer">提交答案</button>
        <button class="ghost-btn" id="next-mistake">下一题</button>
      `,
    })}
    <div class="mistake-last-answer">
      <span>上次错选：${escapeHtml(mistake?.selected || "-")}</span>
      <span>正确答案：${escapeHtml(mistake?.answer || question.answer)}</span>
      ${lastTime ? `<span>${escapeHtml(lastTime)}</span>` : ""}
    </div>
  `;

  card.querySelectorAll(".option").forEach((button) => {
    button.addEventListener("click", () => toggleMistakeAnswer(button.dataset.answer));
  });
  byId("submit-mistake-answer").addEventListener("click", submitMistakeAnswer);
  byId("prev-mistake").addEventListener("click", () => moveMistakeQuestion(-1));
  byId("next-mistake").addEventListener("click", () => moveMistakeQuestion(1));
  byId("master-mistake").addEventListener("click", markCurrentMistakeMastered);
}

function renderMistakeCategoryOptions() {
  const select = byId("mistake-category-select");
  if (!select) return;
  const currentValue = select.value || "all";
  select.innerHTML = CATEGORIES.map((category) => {
    const count = getMistakeQuestions(category.id).length;
    const label = category.id === "all" ? "全部分类" : category.title;
    return `<option value="${category.id}">${label}（${count}题）</option>`;
  }).join("");
  select.value = CATEGORIES.some((category) => category.id === currentValue) ? currentValue : "all";
  select.disabled = getMistakeQuestions().length === 0;
}

function getMistakeQuestions(categoryId = "all") {
  return Object.values(state.mistakes)
    .map((item) => ({ ...item, question: getQuestionById(item.questionId) }))
    .filter((item) => item.question)
    .filter((item) => categoryId === "all" || questionMatchesCategory(item.question, categoryId))
    .sort((a, b) => b.time.localeCompare(a.time))
    .map((item) => item.question);
}

function getFilteredMistakeQuestions() {
  const select = byId("mistake-category-select");
  return getMistakeQuestions(select?.value || "all");
}

function toggleMistakeAnswer(answer) {
  if (mistakeSubmitted) return;
  const question = mistakeQuestions[mistakeIndex];
  mistakeSelectedAnswers = updateSelectedAnswers(question, mistakeSelectedAnswers, answer);
  markSelectedOptions(byId("mistake-card"), mistakeSelectedAnswers);
}

function getSelectedMistakeAnswerText() {
  return [...mistakeSelectedAnswers].sort().join("");
}

function submitMistakeAnswer() {
  if (mistakeSubmitted) return;
  const question = mistakeQuestions[mistakeIndex];
  if (!question) return;
  const panel = byId("mistake-answer-panel");
  if (!mistakeSelectedAnswers.size) {
    showAnswerNotice(panel, "请先选择答案。");
    return;
  }

  mistakeSubmitted = true;
  const selected = getSelectedMistakeAnswerText();
  const isCorrect = normalizeAnswer(selected) === normalizeAnswer(question.answer);
  recordAnswer(question, selected, isCorrect);
  markOptions(question, selected, byId("mistake-card"));
  renderAnswerPanel(question, selected, isCorrect, panel);
  byId("submit-mistake-answer").hidden = true;
}

function moveMistakeQuestion(step) {
  if (!mistakeQuestions.length) return;
  mistakeIndex = Math.min(Math.max(mistakeIndex + step, 0), mistakeQuestions.length - 1);
  resetMistakeAnswerState();
  renderMistakes();
}

function markCurrentMistakeMastered() {
  const question = mistakeQuestions[mistakeIndex];
  if (!question) return;
  delete state.mistakes[question.id];
  state.meta.removedMistakes[question.id] = new Date().toISOString();
  saveState();
  resetMistakeAnswerState();
  renderMistakes();
  updateStats();
}

function renderRecords() {
  const list = byId("record-list");
  if (!state.records.length) {
    list.innerHTML = `<div class="empty-state"><h2>暂无答题记录</h2><p>开始刷题后，这里会记录最近 300 次作答。</p></div>`;
    return;
  }

  list.innerHTML = state.records.map((record) => {
    const question = getQuestionById(record.questionId);
    if (!question) return "";
    const time = new Date(record.time).toLocaleString("zh-CN");
    return `
      <article class="list-item">
        <h3>${escapeHtml(question.stem)}</h3>
        <p>${record.correct ? "答对" : "答错"} · ${escapeHtml(question.categoryTitle)} · ${escapeHtml(TYPE_LABELS[question.type] || "题目")} · ${time}</p>
        <p>你的答案：${escapeHtml(record.selected)}　正确答案：${escapeHtml(record.answer)}</p>
      </article>
    `;
  }).join("");
}

function clearMistakes() {
  state.mistakes = {};
  state.meta.mistakesClearedAt = new Date().toISOString();
  mistakeIndex = 0;
  resetMistakeAnswerState();
  saveState();
  renderMistakes();
  updateStats();
  updateProgressDisplays();
}

function resetProgress() {
  clearNoteSaveTimers();
  const clientId = state.clientId;
  const resetAt = new Date().toISOString();
  state = getEmptyState();
  state.clientId = clientId;
  state.meta.resetAt = resetAt;
  state.meta.updatedAt = resetAt;
  mistakeIndex = 0;
  resetMistakeAnswerState();
  saveState();
  updateStats();
  updateProgressDisplays();
  renderRecords();
  renderMistakes();
}

function getSupabaseConfig() {
  const config = window.SUPABASE_SYNC_CONFIG || {};
  if (!config.url || !config.anonKey) return null;
  return config;
}

function isSyncConfigured() {
  return Boolean(getSupabaseConfig() && window.supabase);
}

async function initSync() {
  renderSyncUi();
  if (!isSyncConfigured()) {
    setSyncStatus("未配置云同步；当前记录只保存在本机。");
    return;
  }

  const config = getSupabaseConfig();
  supabaseClient = window.supabase.createClient(config.url, config.anonKey);
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    setSyncStatus("同步初始化失败，本地记录仍可使用。");
    return;
  }

  syncSession = data.session;
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    syncSession = session;
    renderSyncUi();
    if (session) syncFromCloud({ pushAfterMerge: true });
  });

  renderSyncUi();
  if (syncSession) syncFromCloud({ pushAfterMerge: true });
}

function renderSyncUi() {
  const form = byId("sync-form");
  const actions = byId("sync-actions");
  const email = byId("sync-email");
  const user = byId("sync-user");
  if (!form || !actions) return;

  const configured = isSyncConfigured();
  form.hidden = Boolean(syncSession) || !configured;
  actions.hidden = !syncSession;
  if (email) email.disabled = !configured;
  if (user && syncSession) user.textContent = syncSession.user.email || "已开启同步";

  if (!configured) {
    setSyncStatus("未配置 Supabase。填入 sync-config.js 后即可开启电脑和手机同步。");
  } else if (syncSession) {
    setSyncStatus(lastSyncMessage || "已开启同步。");
  } else {
    setSyncStatus("输入邮箱开启同步；电脑和手机用同一个邮箱即可合并记录。");
  }
}

function setSyncStatus(message) {
  lastSyncMessage = message;
  const status = byId("sync-status");
  if (status) status.textContent = message;
}

async function requestSyncEmail(event) {
  event.preventDefault();
  if (!supabaseClient) {
    setSyncStatus("还没有配置 Supabase，暂时只能本机保存。");
    return;
  }

  const emailInput = byId("sync-email");
  const email = emailInput.value.trim();
  if (!email) {
    setSyncStatus("请输入邮箱后再开启同步。");
    return;
  }

  setSyncStatus("正在发送同步邮件...");
  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: window.location.href.split("#")[0],
    },
  });

  if (error) {
    setSyncStatus(`同步邮件发送失败：${error.message}`);
    return;
  }
  setSyncStatus("同步邮件已发送，请在电脑或手机浏览器里打开邮件链接。");
}

async function signOutSync() {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  syncSession = null;
  renderSyncUi();
  setSyncStatus("已退出同步；本机记录仍保留。");
}

async function syncFromCloud(options = {}) {
  const { pushAfterMerge = false } = options;
  if (!supabaseClient || !syncSession || syncPulling) return;

  syncPulling = true;
  setSyncStatus("正在同步...");
  try {
    const { data, error } = await supabaseClient
      .from(SYNC_TABLE)
      .select("state, updated_at")
      .eq("user_id", syncSession.user.id)
      .maybeSingle();

    if (error) throw error;

    if (data?.state) {
      const merged = mergeStates(state, data.state);
      state = merged;
      saveState({ touch: false, sync: false });
      refreshCurrentView();
    }

    if (!data?.state || pushAfterMerge) {
      await pushStateToCloud();
    } else {
      setSyncStatus("已同步到最新记录。");
    }
  } catch (error) {
    setSyncStatus(`本地已保存，云同步稍后重试：${error.message}`);
  } finally {
    syncPulling = false;
    renderSyncUi();
  }
}

function scheduleCloudSave() {
  if (!supabaseClient || !syncSession) return;
  if (syncSaveTimer) clearTimeout(syncSaveTimer);
  setSyncStatus("本地已保存，准备云同步...");
  syncSaveTimer = setTimeout(() => {
    pushStateToCloud();
  }, 900);
}

async function pushStateToCloud() {
  if (!supabaseClient || !syncSession) return;
  if (syncSaveTimer) {
    clearTimeout(syncSaveTimer);
    syncSaveTimer = null;
  }

  try {
    const updatedAt = state.meta.updatedAt || new Date().toISOString();
    const { error } = await supabaseClient
      .from(SYNC_TABLE)
      .upsert({
        user_id: syncSession.user.id,
        state,
        updated_at: updatedAt,
      }, { onConflict: "user_id" });

    if (error) throw error;
    setSyncStatus(`已云同步：${new Date(updatedAt).toLocaleString("zh-CN")}`);
  } catch (error) {
    setSyncStatus(`本地已保存，云同步稍后重试：${error.message}`);
  }
}

function mergeStates(localState, cloudState) {
  const local = normalizeState(localState);
  const cloud = normalizeState(cloudState);
  const mergedMeta = mergeMeta(local.meta, cloud.meta);
  const latestResetAt = mergedMeta.resetAt;
  const merged = {
    ...getEmptyState(),
    clientId: local.clientId,
    meta: mergedMeta,
    statsByClient: mergeStatsByClient(local.statsByClient, cloud.statsByClient, latestResetAt),
    records: mergeRecords(local.records, cloud.records, latestResetAt),
    mistakes: mergeMistakes(local.mistakes, cloud.mistakes, mergedMeta, latestResetAt),
    notes: mergeNotes(local.notes, cloud.notes, mergedMeta, latestResetAt),
  };

  merged.meta.updatedAt = maxIso(local.meta.updatedAt, cloud.meta.updatedAt, new Date().toISOString());
  return recomputeStats(normalizeState(merged));
}

function mergeMeta(localMeta, cloudMeta) {
  return {
    updatedAt: maxIso(localMeta.updatedAt, cloudMeta.updatedAt),
    resetAt: maxIso(localMeta.resetAt, cloudMeta.resetAt),
    mistakesClearedAt: maxIso(localMeta.mistakesClearedAt, cloudMeta.mistakesClearedAt),
    removedMistakes: mergeTimestampMaps(localMeta.removedMistakes, cloudMeta.removedMistakes),
    deletedNotes: mergeTimestampMaps(localMeta.deletedNotes, cloudMeta.deletedNotes),
  };
}

function mergeTimestampMaps(left, right) {
  const merged = { ...left };
  Object.entries(right || {}).forEach(([key, time]) => {
    merged[key] = maxIso(merged[key], time);
  });
  return merged;
}

function mergeStatsByClient(localStats, cloudStats, latestResetAt) {
  const merged = {};
  [localStats, cloudStats].forEach((source) => {
    Object.entries(source || {}).forEach(([clientId, stats]) => {
      if (latestResetAt && !isAfter(stats.updatedAt, latestResetAt)) return;
      const current = merged[clientId];
      if (!current || isAfter(stats.updatedAt, current.updatedAt)) {
        merged[clientId] = { ...stats };
      }
    });
  });
  return merged;
}

function mergeRecords(localRecords, cloudRecords, latestResetAt) {
  const byId = new Map();
  [...localRecords, ...cloudRecords].forEach((record) => {
    if (latestResetAt && !isAfter(record.time, latestResetAt)) return;
    const current = byId.get(record.id);
    if (!current || isAfter(record.time, current.time)) byId.set(record.id, record);
  });
  return [...byId.values()].sort((a, b) => b.time.localeCompare(a.time)).slice(0, 300);
}

function mergeMistakes(localMistakes, cloudMistakes, mergedMeta, latestResetAt) {
  const merged = {};
  [localMistakes, cloudMistakes].forEach((source) => {
    Object.entries(source || {}).forEach(([questionId, mistake]) => {
      const removedAt = maxIso(mergedMeta.removedMistakes[questionId], mergedMeta.mistakesClearedAt, latestResetAt);
      if (!isAfter(mistake.time, removedAt)) return;
      const current = merged[questionId];
      if (!current || isAfter(mistake.time, current.time)) merged[questionId] = { ...mistake };
    });
  });
  return merged;
}

function mergeNotes(localNotes, cloudNotes, mergedMeta, latestResetAt) {
  const merged = {};
  [localNotes, cloudNotes].forEach((source) => {
    Object.entries(source || {}).forEach(([questionId, note]) => {
      const deletedAt = maxIso(mergedMeta.deletedNotes[questionId], latestResetAt);
      if (!isAfter(note.updatedAt, deletedAt)) return;
      const current = merged[questionId];
      if (!current || isAfter(note.updatedAt, current.updatedAt)) merged[questionId] = { ...note };
    });
  });
  return merged;
}

function refreshCurrentView() {
  updateStats();
  updateProgressDisplays();
  if (document.getElementById("view-mistakes")?.classList.contains("active")) renderMistakes();
  if (document.getElementById("view-records")?.classList.contains("active")) renderRecords();
  document.querySelectorAll("[data-note-question-id]").forEach((textarea) => {
    const text = getNoteText(textarea.dataset.noteQuestionId);
    if (textarea.value !== text) textarea.value = text;
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", () => showView(item.dataset.view));
  });
  byId("start-practice").addEventListener("click", () => startPractice(false));
  byId("shuffle-practice").addEventListener("click", () => startPractice(true));
  byId("clear-mistakes").addEventListener("click", clearMistakes);
  byId("mistake-category-select").addEventListener("change", () => {
    mistakeIndex = 0;
    resetMistakeAnswerState();
    renderMistakes();
  });
  byId("reset-progress").addEventListener("click", resetProgress);
  byId("sync-form").addEventListener("submit", requestSyncEmail);
  byId("sync-now").addEventListener("click", () => syncFromCloud({ pushAfterMerge: true }));
  byId("sync-signout").addEventListener("click", signOutSync);
  window.addEventListener("focus", () => {
    if (syncSession) syncFromCloud();
  });
}

function init() {
  renderCategories();
  renderSelectors();
  updateStats();
  bindEvents();
  initSync();
}

init();
