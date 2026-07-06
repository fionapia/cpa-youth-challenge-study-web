import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const questionDir = path.join(rootDir, "练习题库");
const outputFile = path.join(__dirname, "questions-data.js");

const CATEGORY_RULES = [
  {
    id: "policy",
    title: "行业重要政策性文件",
    match: (file, section) => !file.includes("机考冲刺") && section.includes("政策"),
  },
  {
    id: "ethics",
    title: "行业史与职业道德",
    match: (file, section) =>
      !file.includes("机考冲刺") &&
      (section.includes("职业道德") ||
        section.includes("独立性") ||
        section.includes("行业史")),
  },
  {
    id: "laws",
    title: "行业重要法规与准则",
    match: (file, section) =>
      file.includes("法律层") ||
      file.includes("法律政策") ||
      file.includes("CAS") ||
      file.includes("企业会计准则") ||
      file.includes("审计") ||
      section.includes("审计准则"),
  },
  {
    id: "ethics",
    title: "行业史与职业道德",
    match: (file) => file.includes("职业道德"),
  },
  {
    id: "cram",
    title: "机考冲刺",
    match: (file) => file.includes("机考冲刺"),
  },
];

const TAG_RULES = [
  {
    id: "cram",
    match: (file) => file.includes("机考冲刺"),
  },
  {
    id: "policy",
    match: (file, section) => file.includes("法律政策") || section.includes("政策"),
  },
  {
    id: "ethics",
    match: (file, section) =>
      file.includes("职业道德独立性") ||
      section.includes("职业道德") ||
      section.includes("独立性") ||
      section.includes("行业史"),
  },
  {
    id: "laws",
    match: (file, section) =>
      file.includes("法律层") ||
      file.includes("法律政策") ||
      file.includes("CAS") ||
      file.includes("企业会计准则") ||
      (file.includes("审计") && !file.includes("政策") && !file.includes("职业道德")) ||
      section.includes("审计准则"),
  },
];

const TYPE_RULES = [
  { type: "multiple", match: (section) => section.includes("多选") },
  { type: "judge", match: (section) => section.includes("判断") },
  { type: "single", match: (section) => section.includes("单选") },
];

function normalizeText(value) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\uFEFF/g, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function stripMarkdown(value) {
  return value
    .replace(/^\*+|\*+$/g, "")
    .replace(/\*\*/g, "")
    .trim();
}

function getType(section) {
  const rule = TYPE_RULES.find((item) => item.match(section));
  return rule ? rule.type : "single";
}

function getCategory(file, section) {
  const rule = CATEGORY_RULES.find((item) => item.match(file, section));
  return rule ? rule.id : "all";
}

function getTags(file, section, category) {
  const tags = new Set([category]);
  for (const rule of TAG_RULES) {
    if (rule.match(file, section)) tags.add(rule.id);
  }
  tags.delete("all");
  return [...tags];
}

function getCategoryTitle(id) {
  if (id === "all") return "全部试题";
  return CATEGORY_RULES.find((item) => item.id === id)?.title || id;
}

function parseAnswerLine(line) {
  const match = line.match(/\*\*答案[:：]\s*([^*|]+)\*\*(?:\s*\|\s*(.+))?/);
  if (!match) return null;
  return {
    answer: match[1].trim().replace(/\s+/g, ""),
    explanation: match[2] ? stripMarkdown(match[2]) : "",
  };
}

function isQuestionStart(line) {
  return /^\s*(?:\*\*)?\d+[.．、]\s*/.test(line);
}

function cleanStemLine(line) {
  return stripMarkdown(line.replace(/^\s*(?:\*\*)?\d+[.．、]\s*/, ""));
}

function splitQuestionAndInlineOptions(line) {
  const firstOption = line.search(/\s+A[.．]\s*/);
  if (firstOption < 0) return { stem: line.trim(), inlineOptions: "" };
  return {
    stem: line.slice(0, firstOption).trim(),
    inlineOptions: line.slice(firstOption).trim(),
  };
}

function parseOptionLine(line) {
  const trimmed = stripMarkdown(line);
  const match = trimmed.match(/^([A-F])[.．]\s*(.+)$/);
  if (!match) return null;
  return { key: match[1], text: match[2].trim() };
}

function parseInlineOptions(text) {
  if (!text) return [];
  const matches = [...text.matchAll(/([A-F])[.．]\s*/g)];
  return matches.map((match, index) => {
    const next = matches[index + 1];
    const start = match.index + match[0].length;
    const end = next ? next.index : text.length;
    return {
      key: match[1],
      text: stripMarkdown(text.slice(start, end)),
    };
  }).filter((option) => option.text);
}

function parseQuestionBlock(block, meta) {
  const answerIndex = block.findIndex((line) => parseAnswerLine(line));
  if (answerIndex < 0) return null;

  const answerInfo = parseAnswerLine(block[answerIndex]);
  const beforeAnswer = block.slice(0, answerIndex).filter((line) => line.trim());
  if (!beforeAnswer.length) return null;

  const stemRaw = cleanStemLine(beforeAnswer[0]);
  const { stem, inlineOptions } = splitQuestionAndInlineOptions(stemRaw);
  const options = parseInlineOptions(inlineOptions);
  const optionKeys = new Set(options.map((option) => option.key));
  const extraStem = [];

  for (const line of beforeAnswer.slice(1)) {
    const inlineLineOptions = parseInlineOptions(stripMarkdown(line));
    if (inlineLineOptions.length > 1) {
      for (const option of inlineLineOptions) {
        if (!optionKeys.has(option.key)) {
          options.push(option);
          optionKeys.add(option.key);
        }
      }
      continue;
    }

    const option = parseOptionLine(line);
    if (option) {
      if (!optionKeys.has(option.key)) {
        options.push(option);
        optionKeys.add(option.key);
      }
    } else {
      extraStem.push(stripMarkdown(line));
    }
  }

  const fullStem = [stem, ...extraStem].filter(Boolean).join("\n");
  if (!fullStem) return null;

  return {
    id: meta.id,
    sourceFile: meta.file,
    category: meta.category,
    tags: meta.tags,
    categoryTitle: getCategoryTitle(meta.category),
    section: meta.section,
    type: meta.type,
    stem: fullStem,
    options,
    answer: answerInfo.answer,
    explanation: answerInfo.explanation,
  };
}

function parseFile(file) {
  const fullPath = path.join(questionDir, file);
  const lines = normalizeText(fs.readFileSync(fullPath, "utf8")).split("\n");
  const questions = [];
  let section = "";
  let block = [];

  function flushBlock() {
    if (!block.length) return;
    if (!section.includes("简答")) {
      const type = getType(section);
      const category = getCategory(file, section);
      const parsed = parseQuestionBlock(block, {
        id: `${path.basename(file, ".md")}::${questions.length + 1}`,
        file,
        section,
        type,
        category,
        tags: getTags(file, section, category),
      });
      if (parsed) questions.push(parsed);
    }
    block = [];
  }

  for (const line of lines) {
    const sectionMatch = line.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      flushBlock();
      section = stripMarkdown(sectionMatch[1]);
      continue;
    }

    if (isQuestionStart(line)) {
      flushBlock();
      block = [line];
      continue;
    }

    if (block.length) block.push(line);
  }

  flushBlock();
  return questions;
}

const files = fs
  .readdirSync(questionDir)
  .filter((file) => file.endsWith(".md"))
  .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));

const questions = files.flatMap(parseFile).map((question, index) => ({
  ...question,
  id: `q${String(index + 1).padStart(4, "0")}`,
}));

const stats = questions.reduce(
  (acc, question) => {
    acc.total += 1;
    acc.byType[question.type] = (acc.byType[question.type] || 0) + 1;
    acc.byCategory[question.category] = (acc.byCategory[question.category] || 0) + 1;
    return acc;
  },
  { total: 0, byType: {}, byCategory: {} },
);

const content = `// Generated by build-question-data.mjs. Do not edit manually.
window.QUESTION_BANK = ${JSON.stringify(questions, null, 2)};
window.QUESTION_BANK_STATS = ${JSON.stringify(stats, null, 2)};
`;

fs.writeFileSync(outputFile, content, "utf8");
console.log(JSON.stringify(stats, null, 2));
