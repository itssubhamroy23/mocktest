"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import questionsData from "@/data/questions.json";
import aegclQuestionsData from "@/data/aegcl-questions.json";
import apdclQuestionsData from "@/data/apdcl-questions.json";
import apgclItQuestionsData from "@/data/apgcl-it-questions.json";
import aegclItQuestionsData from "@/data/aegcl-it-questions.json";
import apdclItQuestionsData from "@/data/apdcl-it-questions.json";
import demoClaudeQuestionsData from "@/data/demo-claude-questions.json";
import demoChatgptQuestionsData from "@/data/demo-chatgpt-questions.json";
import demoChatgptMock2QuestionsData from "@/data/demo-chatgpt-mock2-questions.json";
import demoGeminiQuestionsData from "@/data/demo-gemini-questions.json";
import type { OptionKey, Question } from "@/lib/types";

const DEFAULT_QUESTIONS = questionsData as Question[];
const AEGCL_QUESTIONS = aegclQuestionsData as Question[];
const APDCL_QUESTIONS = apdclQuestionsData as Question[];
const APGCL_IT_QUESTIONS = apgclItQuestionsData as Question[];
const AEGCL_IT_QUESTIONS = aegclItQuestionsData as Question[];
const APDCL_IT_QUESTIONS = apdclItQuestionsData as Question[];
const DEMO_CLAUDE_QUESTIONS = demoClaudeQuestionsData as Question[];
const DEMO_CHATGPT_QUESTIONS = demoChatgptQuestionsData as Question[];
const DEMO_CHATGPT_MOCK2_QUESTIONS = demoChatgptMock2QuestionsData as Question[];
const DEMO_GEMINI_QUESTIONS = demoGeminiQuestionsData as Question[];

// Built-in sets grouped by organization, each holding its available papers
// (General Studies, Information Technology, ...). Add a new org or paper
// here and it shows up on the start screen automatically.
const BUILTIN_GROUPS: { org: string; papers: QuestionSet[] }[] = [
  {
    org: "APGCL",
    papers: [
      { name: "APGCL — General Studies", questions: DEFAULT_QUESTIONS },
      { name: "APGCL — Information Technology", questions: APGCL_IT_QUESTIONS },
    ],
  },
  {
    org: "AEGCL",
    papers: [
      { name: "AEGCL — General Studies", questions: AEGCL_QUESTIONS },
      { name: "AEGCL — Information Technology", questions: AEGCL_IT_QUESTIONS },
    ],
  },
  {
    org: "APDCL",
    papers: [
      { name: "APDCL — General Studies", questions: APDCL_QUESTIONS },
      { name: "APDCL — Information Technology", questions: APDCL_IT_QUESTIONS },
    ],
  },
  {
    org: "AI Demo",
    papers: [
      { name: "AI Demo — Claude", questions: DEMO_CLAUDE_QUESTIONS },
      { name: "AI Demo — ChatGPT", questions: DEMO_CHATGPT_QUESTIONS },
      { name: "AI Demo — ChatGPT Mock 2", questions: DEMO_CHATGPT_MOCK2_QUESTIONS },
      { name: "AI Demo — Gemini", questions: DEMO_GEMINI_QUESTIONS },
    ],
  },
];
const BUILTIN_SETS: QuestionSet[] = BUILTIN_GROUPS.flatMap((g) => g.papers);
const DEFAULT_SET_NAME = BUILTIN_GROUPS[0].papers[0].name;
const STORAGE_KEY = "mocktest.customSets";
const SAVED_STORAGE_KEY = "mocktest.savedQuestions";
const SESSION_STORAGE_KEY = "mocktest.session";
const NOTES_STORAGE_KEY = "mocktest.notes";
const AI_CHAT_URL_STORAGE_KEY = "mocktest.aiChatUrl";
// Window name so every "Ask AI" click reuses one browser tab instead of piling up new ones.
const AI_TAB_NAME = "mocktest-ai";

const TIME_ALLOWED_SECONDS = 2 * 60 * 60; // 2 hours
const NEGATIVE_MARK = 0.25;

type Phase = "start" | "quiz" | "results" | "revision" | "notes";
type QuestionSet = { name: string; questions: Question[] };
type SavedQuestion = { setName: string; question: Question };
// Per-question notes, keyed by noteKey(setName, questionId).
type Notes = Record<string, string>;

// Free "Ask AI": open the question in the user's own Claude / ChatGPT tab with
// the prompt pre-filled. No API key or server call involved.
const AI_TARGETS = [
  { name: "Claude", url: (prompt: string) => `https://claude.ai/new?q=${encodeURIComponent(prompt)}` },
  { name: "ChatGPT", url: (prompt: string) => `https://chatgpt.com/?q=${encodeURIComponent(prompt)}` },
];
const AI_QUICK_ASKS = [
  "Explain the correct answer.",
  "Why are the other options wrong?",
  "Give me a hint without telling me the answer.",
];

function buildAiPrompt(q: Question, chosen: OptionKey | undefined, doubt: string) {
  const opts = (Object.keys(q.options) as OptionKey[])
    .map((k) => `(${k}) ${q.options[k]}`)
    .join("\n");
  return [
    "I'm practising a multiple-choice mock test for an Assam power-sector recruitment exam (APGCL / AEGCL / APDCL). Help me with this question. Keep it short and exam-focused, and add a memory tip if useful. If the answer key looks wrong, say so.",
    "",
    `Question: ${q.question}`,
    opts,
    `Answer key: (${q.correctAnswer})`,
    chosen ? `I picked: (${chosen})` : "I haven't answered yet.",
    "",
    `My doubt: ${doubt.trim() || AI_QUICK_ASKS[0]}`,
  ].join("\n");
}

function noteKey(setName: string, qId: number) {
  return `${setName}::${qId}`;
}
type SessionState = {
  phase: "quiz" | "results";
  selectedSetName: string;
  activeQuestions: Question[];
  answers: Record<number, OptionKey>;
  markedForReview: number[];
  current: number;
  timeLeft: number; // seconds remaining on the clock
  paused: boolean; // clock frozen; resume from exactly here
  pauseOverlay: boolean; // show the full-screen "Test Paused" curtain
  savedAt: number; // epoch ms this snapshot was written
};

function isValidQuestion(q: unknown): q is Question {
  if (!q || typeof q !== "object") return false;
  const r = q as Record<string, unknown>;
  if (typeof r.id !== "number" || typeof r.question !== "string") return false;
  if (typeof r.correctAnswer !== "string" || !["A", "B", "C", "D"].includes(r.correctAnswer)) return false;
  if (!r.options || typeof r.options !== "object") return false;
  const opts = r.options as Record<string, unknown>;
  return ["A", "B", "C", "D"].every((k) => typeof opts[k] === "string");
}

function parseQuestionsFile(raw: string): Question[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("JSON must be a non-empty array of questions");
  }
  if (!parsed.every(isValidQuestion)) {
    throw new Error("Each question needs id, question, options {A,B,C,D}, correctAnswer");
  }
  return parsed;
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function formatTime(totalSeconds: number) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function isPhase(v: string | null): v is Phase {
  return v === "start" || v === "quiz" || v === "results" || v === "revision" || v === "notes";
}

function QuizApp() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [phase, setPhase] = useState<Phase>("start");
  const isInternalNav = useRef(false);
  const prevPhaseRef = useRef<Phase>("start");
  const didMountPhaseSync = useRef(false);
  const hydratedRef = useRef(false);
  const [current, setCurrent] = useState(0);
  const [answers, setAnswers] = useState<Record<number, OptionKey>>({});
  const [markedForReview, setMarkedForReview] = useState<Set<number>>(new Set());
  const [timeLeft, setTimeLeft] = useState(TIME_ALLOWED_SECONDS);
  const [paused, setPaused] = useState(false);
  // When paused via the plain "Pause timer" button the questions stay visible;
  // the "Pause" button also drops a full-screen curtain over them.
  const [pauseOverlay, setPauseOverlay] = useState(false);
  const [customSets, setCustomSets] = useState<QuestionSet[]>([]);
  const [selectedSetName, setSelectedSetName] = useState<string>(DEFAULT_SET_NAME);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [savedQuestions, setSavedQuestions] = useState<SavedQuestion[]>([]);
  const [copiedQ, setCopiedQ] = useState(false);
  const [notes, setNotes] = useState<Notes>({});
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInput, setAiInput] = useState("");
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  // Link to the user's ongoing Claude/ChatGPT conversation, so every doubt goes
  // into the same chat. Sites can't be typed into from here, so we copy the
  // prompt and bring that chat up; the user pastes.
  const [aiChatUrl, setAiChatUrl] = useState("");
  const [aiChatUrlDraft, setAiChatUrlDraft] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const questions =
    customSets.find((s) => s.name === selectedSetName)?.questions ??
    BUILTIN_SETS.find((s) => s.name === selectedSetName)?.questions ??
    DEFAULT_QUESTIONS;
  const [activeQuestions, setActiveQuestions] = useState<Question[]>(questions);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as QuestionSet[];
      if (Array.isArray(parsed) && parsed.every((s) => s.name && Array.isArray(s.questions))) {
        setCustomSets(parsed);
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  function persistCustomSets(sets: QuestionSet[]) {
    setCustomSets(sets);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sets));
  }

  useEffect(() => {
    const stored = localStorage.getItem(SAVED_STORAGE_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as SavedQuestion[];
      if (Array.isArray(parsed) && parsed.every((s) => s.setName && isValidQuestion(s.question))) {
        setSavedQuestions(parsed);
      }
    } catch {
      localStorage.removeItem(SAVED_STORAGE_KEY);
    }
  }, []);

  function persistSavedQuestions(list: SavedQuestion[]) {
    setSavedQuestions(list);
    localStorage.setItem(SAVED_STORAGE_KEY, JSON.stringify(list));
  }

  useEffect(() => {
    const stored = localStorage.getItem(NOTES_STORAGE_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        setNotes(parsed as Notes);
      }
    } catch {
      localStorage.removeItem(NOTES_STORAGE_KEY);
    }
  }, []);

  function updateNote(setName: string, qId: number, text: string) {
    setNotes((prev) => {
      const next = { ...prev };
      if (text.trim()) next[noteKey(setName, qId)] = text;
      else delete next[noteKey(setName, qId)];
      localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  // Every saved note joined back to its question, grouped by set. Notes whose
  // set or question no longer exists (e.g. deleted custom set) are skipped.
  const notesBySet = useMemo(() => {
    const allSets = [...BUILTIN_SETS, ...customSets];
    const groups: { setName: string; items: { question: Question; note: string }[] }[] = [];
    for (const set of allSets) {
      const items = set.questions
        .filter((q) => notes[noteKey(set.name, q.id)])
        .map((q) => ({ question: q, note: notes[noteKey(set.name, q.id)] }));
      if (items.length > 0) groups.push({ setName: set.name, items });
    }
    return groups;
  }, [notes, customSets]);
  const notesCount = notesBySet.reduce((n, g) => n + g.items.length, 0);

  function isQuestionSaved(q: Question) {
    return savedQuestions.some((s) => s.setName === selectedSetName && s.question.id === q.id);
  }

  function toggleSaveQuestion(q: Question) {
    if (isQuestionSaved(q)) {
      persistSavedQuestions(
        savedQuestions.filter((s) => !(s.setName === selectedSetName && s.question.id === q.id))
      );
    } else {
      persistSavedQuestions([...savedQuestions, { setName: selectedSetName, question: q }]);
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsedQuestions = parseQuestionsFile(reader.result as string);
        let name = file.name.replace(/\.json$/i, "");
        const existingNames = new Set(customSets.map((s) => s.name));
        BUILTIN_SETS.forEach((s) => existingNames.add(s.name));
        let suffix = 2;
        const base = name;
        while (existingNames.has(name)) {
          name = `${base} (${suffix})`;
          suffix++;
        }
        persistCustomSets([...customSets, { name, questions: parsedQuestions }]);
        setSelectedSetName(name);
        setUploadError(null);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Invalid JSON file");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function deleteSet(name: string) {
    const next = customSets.filter((s) => s.name !== name);
    persistCustomSets(next);
    if (selectedSetName === name) setSelectedSetName(DEFAULT_SET_NAME);
  }

  // On first load, resume an in-progress quiz/results from localStorage if one
  // exists; otherwise strip any stale ?phase from a bookmarked/reloaded URL.
  useEffect(() => {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (raw) {
      try {
        const s = JSON.parse(raw) as SessionState;
        if (
          (s.phase === "quiz" || s.phase === "results") &&
          Array.isArray(s.activeQuestions) &&
          s.activeQuestions.length > 0
        ) {
          // Paused sessions freeze the clock: resume from the exact stored
          // seconds. Running sessions keep counting down real time even while
          // the tab was closed.
          const elapsed = Math.max(0, Math.round((Date.now() - s.savedAt) / 1000));
          const remaining = s.paused
            ? Math.max(0, s.timeLeft)
            : Math.max(0, s.timeLeft - elapsed);
          const restoredPhase: Phase = s.phase === "quiz" && remaining <= 0 ? "results" : s.phase;

          setSelectedSetName(s.selectedSetName);
          setActiveQuestions(s.activeQuestions);
          setAnswers(s.answers ?? {});
          setMarkedForReview(new Set(s.markedForReview ?? []));
          setCurrent(s.current ?? 0);
          setPaused(restoredPhase === "quiz" ? Boolean(s.paused) : false);
          setPauseOverlay(
            restoredPhase === "quiz" && Boolean(s.paused) && Boolean(s.pauseOverlay)
          );
          setTimeLeft(restoredPhase === "quiz" ? remaining : 0);

          prevPhaseRef.current = restoredPhase;
          isInternalNav.current = true;
          router.replace(`${pathname}?phase=${restoredPhase}`);
          setPhase(restoredPhase);
          return;
        }
      } catch {
        // fall through to cleanup below
      }
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
    if (searchParams.get("phase")) {
      isInternalNav.current = true;
      router.replace(pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // phase -> URL: push a history entry so browser Back exits quiz/results/revision.
  useEffect(() => {
    if (!didMountPhaseSync.current) {
      // First commit: URL is already correct (default, or set by the restore
      // effect above via router.replace) — don't push a redundant entry.
      didMountPhaseSync.current = true;
      return;
    }
    if (prevPhaseRef.current === phase) return;
    prevPhaseRef.current = phase;
    isInternalNav.current = true;
    router.push(phase === "start" ? pathname : `${pathname}?phase=${phase}`);
  }, [phase, pathname, router]);

  // Persist the in-progress attempt so a refresh (or crash/close) can resume it.
  // Skips its first commit: the restore effect above already read localStorage
  // once for this mount, so re-running with the pre-restore "start" state here
  // would just delete what it's about to set.
  useEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
    if (phase === "quiz" || phase === "results") {
      const session: SessionState = {
        phase,
        selectedSetName,
        activeQuestions,
        answers,
        markedForReview: [...markedForReview],
        current,
        timeLeft,
        paused,
        pauseOverlay,
        savedAt: Date.now(),
      };
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } else {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }, [phase, selectedSetName, activeQuestions, answers, markedForReview, current, timeLeft, paused, pauseOverlay]);

  // URL -> phase: browser Back/Forward should move the app back, not just the URL.
  useEffect(() => {
    if (isInternalNav.current) {
      isInternalNav.current = false;
      return;
    }
    const urlPhase = searchParams.get("phase");
    const next = isPhase(urlPhase) ? urlPhase : "start";
    if (next !== phase) {
      prevPhaseRef.current = next;
      setPhase(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    if (phase !== "quiz") return;
    if (timeLeft <= 0) {
      setPhase("results");
      return;
    }
    if (paused) return;
    const t = setTimeout(() => setTimeLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, timeLeft, paused]);

  const score = useMemo(() => {
    let correct = 0;
    let wrong = 0;
    let skipped = 0;
    for (const q of activeQuestions) {
      const a = answers[q.id];
      if (!a) skipped++;
      else if (a === q.correctAnswer) correct++;
      else wrong++;
    }
    const marks = correct * 1 - wrong * NEGATIVE_MARK;
    return { correct, wrong, skipped, marks };
  }, [answers, activeQuestions]);

  function startQuiz() {
    setActiveQuestions(shuffle(questions));
    setAnswers({});
    setMarkedForReview(new Set());
    setCurrent(0);
    setTimeLeft(TIME_ALLOWED_SECONDS);
    setPaused(false);
    setPauseOverlay(false);
    setAiInput("");
    setAiOpen(false);
    setPhase("quiz");
  }

  function selectOption(qId: number, opt: OptionKey) {
    setAnswers((prev) => ({ ...prev, [qId]: opt }));
  }

  function clearResponse(qId: number) {
    setAnswers((prev) => {
      const next = { ...prev };
      delete next[qId];
      return next;
    });
  }

  function copyQuestion(q: Question) {
    navigator.clipboard?.writeText(q.question).then(
      () => {
        setCopiedQ(true);
        setTimeout(() => setCopiedQ(false), 1500);
      },
      () => {}
    );
  }

  useEffect(() => {
    const stored = localStorage.getItem(AI_CHAT_URL_STORAGE_KEY);
    if (stored) setAiChatUrl(stored);
  }, []);

  function saveAiChatUrl(url: string) {
    const trimmed = url.trim();
    if (trimmed && !/^https:\/\//.test(trimmed)) return;
    setAiChatUrl(trimmed);
    setAiChatUrlDraft("");
    if (trimmed) localStorage.setItem(AI_CHAT_URL_STORAGE_KEY, trimmed);
    else localStorage.removeItem(AI_CHAT_URL_STORAGE_KEY);
  }

  // Starts a brand-new conversation with the prompt pre-filled.
  function openInAi(target: (typeof AI_TARGETS)[number], q: Question) {
    const prompt = buildAiPrompt(q, answers[q.id], aiInput);
    // Also copy, in case the site ignores the pre-filled ?q= text.
    navigator.clipboard?.writeText(prompt).catch(() => {});
    window.open(target.url(prompt), AI_TAB_NAME);
  }

  // Sends this question to the saved conversation: copy, then switch to that chat.
  function sendToSavedChat(q: Question) {
    const prompt = buildAiPrompt(q, answers[q.id], aiInput);
    navigator.clipboard?.writeText(prompt).then(
      () => {
        setCopiedPrompt(true);
        setTimeout(() => setCopiedPrompt(false), 3000);
      },
      () => {}
    );
    window.open(aiChatUrl, AI_TAB_NAME);
  }

  function copyAiPrompt(q: Question) {
    navigator.clipboard?.writeText(buildAiPrompt(q, answers[q.id], aiInput)).then(
      () => {
        setCopiedPrompt(true);
        setTimeout(() => setCopiedPrompt(false), 1500);
      },
      () => {}
    );
  }

  function toggleMarkForReview(qId: number) {
    setMarkedForReview((prev) => {
      const next = new Set(prev);
      if (next.has(qId)) next.delete(qId);
      else next.add(qId);
      return next;
    });
  }

  function submitQuiz() {
    if (confirm("Submit test? You cannot change answers after this.")) {
      setPhase("results");
    }
  }

  function exitQuiz() {
    if (confirm("Exit test? Your progress and timer will be lost.")) {
      router.back();
    }
  }

  if (phase === "start") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black px-4 py-10">
        <div className="max-w-3xl w-full bg-white dark:bg-zinc-900 rounded-xl shadow p-8 text-center space-y-4">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            {selectedSetName}
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            {questions.length} Questions &middot; 2 Hours &middot; Negative marking 0.25 per wrong answer
          </p>

          <div className="text-left space-y-2">
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
              Choose question set
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {BUILTIN_GROUPS.map((group) => (
                <div
                  key={group.org}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 space-y-2"
                >
                  <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                    {group.org}
                  </p>
                  <div className="space-y-2">
                    {group.papers.map((s) => (
                      <button
                        key={s.name}
                        onClick={() => setSelectedSetName(s.name)}
                        className={`w-full rounded-lg border px-3 py-2 text-sm text-left transition ${
                          selectedSetName === s.name
                            ? "border-zinc-900 dark:border-zinc-50 bg-zinc-100 dark:bg-zinc-800"
                            : "border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                        }`}
                      >
                        <span className="text-zinc-900 dark:text-zinc-50">
                          {s.name.replace(`${group.org} — `, "")}
                        </span>
                        <span className="block text-zinc-500 text-xs">
                          {s.questions.length} questions
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {customSets.length > 0 && (
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500 pt-2">
                Custom
              </p>
            )}
            <div className="space-y-2">
              {customSets.map((s) => (
                <div
                  key={s.name}
                  className={`w-full flex items-center justify-between rounded-lg border px-4 py-2 text-sm transition ${
                    selectedSetName === s.name
                      ? "border-zinc-900 dark:border-zinc-50 bg-zinc-100 dark:bg-zinc-800"
                      : "border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  }`}
                >
                  <button
                    onClick={() => setSelectedSetName(s.name)}
                    className="flex-1 text-left text-zinc-900 dark:text-zinc-50"
                  >
                    {s.name} <span className="text-zinc-500">({s.questions.length})</span>
                  </button>
                  <button
                    onClick={() => deleteSet(s.name)}
                    className="text-zinc-400 hover:text-red-600 ml-2"
                    aria-label={`Delete ${s.name}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>

          <button
            onClick={startQuiz}
            className="w-full rounded-full bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black font-medium py-3 hover:opacity-90 transition"
          >
            Start Test
          </button>

          <button
            onClick={() => setPhase("revision")}
            disabled={savedQuestions.length === 0}
            className="w-full rounded-full border border-amber-400 text-amber-700 dark:text-amber-300 font-medium py-2 disabled:opacity-40 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition"
          >
            ★ Revision List ({savedQuestions.length})
          </button>

          <button
            onClick={() => setPhase("notes")}
            disabled={notesCount === 0}
            className="w-full rounded-full border border-blue-400 text-blue-700 dark:text-blue-300 font-medium py-2 disabled:opacity-40 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition"
          >
            ✎ My Notes ({notesCount})
          </button>

          <div className="pt-4 border-t border-zinc-200 dark:border-zinc-800">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full rounded-full border border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-50 font-medium py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition"
            >
              Upload Question Set (JSON)
            </button>
            {uploadError && (
              <p className="text-red-600 text-sm mt-2">{uploadError}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (phase === "quiz") {
    const q = activeQuestions[current];
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black flex flex-col">
        <div className="sticky top-0 z-10 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={exitQuiz}
              aria-label="Exit to home"
              className="rounded-full border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              ← Exit
            </button>
            <div className="flex flex-col leading-tight">
              <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate max-w-[40vw]">
                {selectedSetName}
              </span>
              <span className="font-medium text-zinc-900 dark:text-zinc-50">
                Question {current + 1} / {activeQuestions.length}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`font-mono font-semibold ${
                timeLeft < 300 ? "text-red-600" : "text-zinc-900 dark:text-zinc-50"
              }`}
            >
              {formatTime(timeLeft)}
            </span>
            {paused ? (
              <button
                onClick={() => {
                  setPaused(false);
                  setPauseOverlay(false);
                }}
                className="rounded-full border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
              >
                Resume
              </button>
            ) : (
              <>
                <button
                  onClick={() => setPaused(true)}
                  aria-label="Pause timer, keep questions visible"
                  className="rounded-full border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  Pause timer
                </button>
                <button
                  onClick={() => {
                    setPaused(true);
                    setPauseOverlay(true);
                  }}
                  aria-label="Pause and hide questions"
                  className="rounded-full border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  Pause
                </button>
              </>
            )}
            <button
              onClick={submitQuiz}
              className="rounded-full bg-green-600 text-white text-sm font-medium px-3 py-1.5"
            >
              Finish
            </button>
          </div>
        </div>

        <div className="flex-1 flex flex-col lg:flex-row max-w-5xl mx-auto w-full gap-6 p-4">
          <div className="flex-1 bg-white dark:bg-zinc-900 rounded-xl shadow p-6 lg:sticky lg:top-20 lg:self-start">
            <div className="flex items-start justify-between gap-3 mb-6">
              <p className="text-lg text-zinc-900 dark:text-zinc-50">
                {q.question}
              </p>
              <button
                onClick={() => copyQuestion(q)}
                aria-label="Copy question"
                className="shrink-0 rounded-full border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
              >
                {copiedQ ? "Copied ✓" : "Copy"}
              </button>
              <button
                onClick={() => setAiOpen(true)}
                aria-label="Ask AI about this question"
                className="shrink-0 rounded-full border border-indigo-300 dark:border-indigo-700 px-3 py-1.5 text-xs font-medium text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/20"
              >
                ✦ Ask AI
              </button>
            </div>
            <div className="space-y-3">
              {(Object.keys(q.options) as OptionKey[]).map((key) => {
                const answered = answers[q.id] !== undefined;
                const isChosen = answers[q.id] === key;
                const isCorrect = q.correctAnswer === key;
                let cls =
                  "border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/50";
                if (answered) {
                  if (isCorrect) cls = "border-green-600 bg-green-50 dark:bg-green-900/20";
                  else if (isChosen) cls = "border-red-600 bg-red-50 dark:bg-red-900/20";
                } else if (isChosen) {
                  cls = "border-zinc-900 dark:border-zinc-50 bg-zinc-100 dark:bg-zinc-800";
                }
                return (
                  <label
                    key={key}
                    className={`flex items-center gap-3 rounded-lg border px-4 py-3 transition ${
                      answered ? "cursor-default" : "cursor-pointer"
                    } ${cls}`}
                  >
                    <input
                      type="radio"
                      name={`q-${q.id}`}
                      checked={isChosen}
                      disabled={answered}
                      onChange={() => selectOption(q.id, key)}
                      className="accent-zinc-900 dark:accent-zinc-50"
                    />
                    <span className="font-semibold text-zinc-500 dark:text-zinc-400">
                      ({key})
                    </span>
                    <span className="text-zinc-900 dark:text-zinc-50">
                      {q.options[key]}
                    </span>
                    {answered && isCorrect && (
                      <span className="ml-auto text-green-600 font-semibold">✓</span>
                    )}
                    {answered && isChosen && !isCorrect && (
                      <span className="ml-auto text-red-600 font-semibold">✗</span>
                    )}
                  </label>
                );
              })}
            </div>

            <div className="flex flex-wrap gap-3 mt-4">
              {answers[q.id] !== undefined && (
                <button
                  onClick={() => clearResponse(q.id)}
                  className="rounded-full border border-zinc-300 dark:border-zinc-700 px-4 py-1.5 text-sm text-zinc-900 dark:text-zinc-50 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  Clear & Change
                </button>
              )}
              <button
                onClick={() => toggleMarkForReview(q.id)}
                className={`rounded-full border px-4 py-1.5 text-sm font-medium transition ${
                  markedForReview.has(q.id)
                    ? "border-purple-600 bg-purple-600 text-white"
                    : "border-purple-300 dark:border-purple-700 text-purple-700 dark:text-purple-300"
                }`}
              >
                {markedForReview.has(q.id) ? "Marked for Review" : "Mark for Review"}
              </button>
              <button
                onClick={() => toggleSaveQuestion(q)}
                className={`rounded-full border px-4 py-1.5 text-sm font-medium transition ${
                  isQuestionSaved(q)
                    ? "border-amber-500 bg-amber-500 text-white"
                    : "border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300"
                }`}
              >
                {isQuestionSaved(q) ? "★ Saved for Revision" : "☆ Save for Revision"}
              </button>
            </div>

            <div className="mt-4">
              <label
                htmlFor={`note-${q.id}`}
                className="block text-sm font-medium text-zinc-600 dark:text-zinc-400 mb-1"
              >
                Notes
              </label>
              <textarea
                id={`note-${q.id}`}
                key={q.id}
                value={notes[noteKey(selectedSetName, q.id)] ?? ""}
                onChange={(e) => updateNote(selectedSetName, q.id, e.target.value)}
                placeholder="Write a note for this question…"
                rows={3}
                className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm text-zinc-900 dark:text-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
              />
            </div>

            <div className="flex justify-between mt-6">
              <button
                onClick={() => setCurrent((c) => Math.max(0, c - 1))}
                disabled={current === 0}
                className="rounded-full border border-zinc-300 dark:border-zinc-700 px-5 py-2 disabled:opacity-40 text-zinc-900 dark:text-zinc-50"
              >
                Previous
              </button>
              {current < activeQuestions.length - 1 ? (
                <button
                  onClick={() => setCurrent((c) => Math.min(activeQuestions.length - 1, c + 1))}
                  className="rounded-full bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black px-5 py-2"
                >
                  Next
                </button>
              ) : (
                <button
                  onClick={submitQuiz}
                  className="rounded-full bg-green-600 text-white px-5 py-2"
                >
                  Submit Test
                </button>
              )}
            </div>
          </div>

          <div className="lg:w-64 bg-white dark:bg-zinc-900 rounded-xl shadow p-4 h-fit lg:sticky lg:top-20 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto no-scrollbar">
            <div className="mb-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-green-50 dark:bg-green-900/20 py-2">
                <p className="text-lg font-bold text-green-600">{score.correct}</p>
                <p className="text-[10px] uppercase tracking-wide text-zinc-500">Correct</p>
              </div>
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 py-2">
                <p className="text-lg font-bold text-red-600">{score.wrong}</p>
                <p className="text-[10px] uppercase tracking-wide text-zinc-500">Wrong</p>
              </div>
              <div className="rounded-lg bg-zinc-100 dark:bg-zinc-800 py-2">
                <p className="text-lg font-bold text-zinc-500">{score.skipped}</p>
                <p className="text-[10px] uppercase tracking-wide text-zinc-500">Left</p>
              </div>
            </div>
            <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
              Net: <span className="font-semibold text-zinc-900 dark:text-zinc-50">{score.marks.toFixed(2)}</span> / {activeQuestions.length}
            </p>
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400 mb-3">
              Question Palette
            </p>
            <div className="grid grid-cols-8 lg:grid-cols-6 gap-2">
              {activeQuestions.map((qq, i) => {
                const answered = answers[qq.id] !== undefined;
                const correct = answered && answers[qq.id] === qq.correctAnswer;
                const marked = markedForReview.has(qq.id);
                const isCurrent = i === current;
                const hasNote = Boolean(notes[noteKey(selectedSetName, qq.id)]);
                let colorCls = "bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200";
                if (marked) colorCls = "bg-purple-600 text-white";
                else if (answered) colorCls = correct ? "bg-green-500 text-white" : "bg-red-500 text-white";
                return (
                  <button
                    key={qq.id}
                    onClick={() => setCurrent(i)}
                    className={`relative h-8 w-8 rounded text-xs font-medium flex items-center justify-center transition ${
                      isCurrent ? "ring-2 ring-blue-500" : ""
                    } ${colorCls}`}
                  >
                    {i + 1}
                    {marked && answered && (
                      <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-green-500 border border-white dark:border-zinc-900" />
                    )}
                    {hasNote && (
                      <span className="absolute -bottom-1 -right-1 h-2.5 w-2.5 rounded-full bg-blue-500 border border-white dark:border-zinc-900" />
                    )}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
              <p><span className="inline-block h-2.5 w-2.5 rounded-full bg-green-500 mr-1.5" />Correct</p>
              <p><span className="inline-block h-2.5 w-2.5 rounded-full bg-red-500 mr-1.5" />Wrong</p>
              <p><span className="inline-block h-2.5 w-2.5 rounded-full bg-purple-600 mr-1.5" />Marked for review</p>
              <p><span className="inline-block h-2.5 w-2.5 rounded-full bg-zinc-300 dark:bg-zinc-600 mr-1.5" />Not answered</p>
              <p><span className="inline-block h-2.5 w-2.5 rounded-full bg-blue-500 mr-1.5" />Has note</p>
            </div>
            <button
              onClick={submitQuiz}
              className="w-full mt-4 rounded-full bg-green-600 text-white py-2 text-sm font-medium"
            >
              Submit Test
            </button>
          </div>
        </div>

        {aiOpen && (
          <div className="fixed inset-y-0 right-0 z-40 w-full sm:w-[28rem] flex flex-col bg-white dark:bg-zinc-900 border-l border-zinc-200 dark:border-zinc-800 shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
              <div>
                <p className="font-semibold text-zinc-900 dark:text-zinc-50">Ask AI</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  About question {current + 1} · opens in a new tab · timer keeps running
                </p>
              </div>
              <button
                onClick={() => setAiOpen(false)}
                aria-label="Close AI panel"
                className="text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-50 text-lg"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
              <p className="text-sm text-zinc-700 dark:text-zinc-300 line-clamp-4">{q.question}</p>

              <div className="space-y-2">
                <label
                  htmlFor="ai-doubt"
                  className="block text-sm font-medium text-zinc-600 dark:text-zinc-400"
                >
                  Your doubt
                </label>
                <textarea
                  id="ai-doubt"
                  value={aiInput}
                  onChange={(e) => setAiInput(e.target.value)}
                  placeholder={AI_QUICK_ASKS[0]}
                  rows={3}
                  className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm text-zinc-900 dark:text-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y"
                />
                <div className="flex flex-wrap gap-2">
                  {AI_QUICK_ASKS.map((ask) => (
                    <button
                      key={ask}
                      onClick={() => setAiInput(ask)}
                      className="rounded-full border border-zinc-200 dark:border-zinc-700 px-3 py-1 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                    >
                      {ask}
                    </button>
                  ))}
                </div>
              </div>

              {aiChatUrl ? (
                <div className="space-y-2">
                  <button
                    onClick={() => sendToSavedChat(q)}
                    className="w-full rounded-full bg-indigo-600 text-white text-sm font-medium py-2.5 hover:opacity-90 transition"
                  >
                    Send to my chat ↗
                  </button>
                  {copiedPrompt && (
                    <p className="text-xs font-medium text-green-600">
                      Copied ✓ — in the chat tab press ⌘V then Enter.
                    </p>
                  )}
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 break-all">
                    Using: {aiChatUrl}{" "}
                    <button
                      onClick={() => saveAiChatUrl("")}
                      className="font-medium text-zinc-700 dark:text-zinc-300 hover:underline"
                    >
                      Change
                    </button>
                  </p>
                </div>
              ) : (
                <div className="space-y-3 rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                    <span className="font-semibold">Keep everything in one chat:</span> start a chat
                    below, copy its link from the address bar (e.g. chatgpt.com/c/…), and save it
                    here. After that, every question goes to that same chat.
                  </p>
                  <div className="flex gap-2">
                    {AI_TARGETS.map((target) => (
                      <button
                        key={target.name}
                        onClick={() => openInAi(target, q)}
                        className="flex-1 rounded-full bg-indigo-600 text-white text-sm font-medium py-2 hover:opacity-90 transition"
                      >
                        New {target.name} chat ↗
                      </button>
                    ))}
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      saveAiChatUrl(aiChatUrlDraft);
                    }}
                    className="flex gap-2"
                  >
                    <input
                      value={aiChatUrlDraft}
                      onChange={(e) => setAiChatUrlDraft(e.target.value)}
                      placeholder="Paste chat link (https://…)"
                      className="flex-1 min-w-0 rounded-full border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    <button
                      type="submit"
                      disabled={!/^https:\/\//.test(aiChatUrlDraft.trim())}
                      className="rounded-full border border-indigo-400 text-indigo-700 dark:text-indigo-300 text-sm font-medium px-3 py-1.5 disabled:opacity-40"
                    >
                      Save
                    </button>
                  </form>
                </div>
              )}

              <button
                onClick={() => copyAiPrompt(q)}
                className="w-full rounded-full border border-zinc-300 dark:border-zinc-700 text-sm text-zinc-700 dark:text-zinc-300 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800"
              >
                {copiedPrompt ? "Copied ✓" : "Copy prompt only"}
              </button>

              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Free — uses your own Claude or ChatGPT account, always in the same browser tab.
                Paste anything useful back into this question&apos;s Notes.
              </p>
            </div>
          </div>
        )}

        {paused && !pauseOverlay && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 rounded-full bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black text-sm font-medium px-4 py-2 shadow-lg">
            Timer paused · {formatTime(timeLeft)}
          </div>
        )}

        {paused && pauseOverlay && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
            <div className="max-w-sm w-full bg-white dark:bg-zinc-900 rounded-xl shadow-lg p-8 text-center space-y-4">
              <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-50">
                Test Paused
              </h2>
              <p className="font-mono text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
                {formatTime(timeLeft)}
              </p>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Clock is frozen. Your progress is saved — you can close this tab
                and reopen it later to continue from exactly here.
              </p>
              <button
                onClick={() => {
                  setPaused(false);
                  setPauseOverlay(false);
                }}
                className="w-full rounded-full bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black font-medium py-3 hover:opacity-90 transition"
              >
                Resume Test
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (phase === "notes") {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black px-4 py-10">
        <div className="max-w-3xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
              My Notes
            </h1>
            <button
              onClick={() => setPhase("start")}
              className="rounded-full border border-zinc-300 dark:border-zinc-700 px-4 py-1.5 text-sm text-zinc-900 dark:text-zinc-50"
            >
              Back
            </button>
          </div>

          {notesBySet.length === 0 ? (
            <p className="text-zinc-500 dark:text-zinc-400">No notes yet.</p>
          ) : (
            notesBySet.map(({ setName, items }) => (
              <div key={setName} className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                  {setName} · {items.length}
                </p>
                {items.map(({ question: q, note }) => (
                  <div
                    key={`${setName}-${q.id}`}
                    className="bg-white dark:bg-zinc-900 rounded-xl shadow p-5"
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <p className="font-medium text-zinc-900 dark:text-zinc-50">
                        {q.id}. {q.question}
                      </p>
                      <button
                        onClick={() => {
                          if (confirm("Delete this note?")) updateNote(setName, q.id, "");
                        }}
                        className="shrink-0 text-zinc-400 hover:text-red-600"
                        aria-label="Delete note"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="text-sm space-y-1">
                      {(Object.keys(q.options) as OptionKey[]).map((key) => {
                        const isRightAnswer = q.correctAnswer === key;
                        return (
                          <p
                            key={key}
                            className={
                              isRightAnswer
                                ? "text-green-600 font-semibold"
                                : "text-zinc-600 dark:text-zinc-400"
                            }
                          >
                            ({key}) {q.options[key]}
                            {isRightAnswer && " ✓"}
                          </p>
                        );
                      })}
                    </div>
                    <p className="mt-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
                      <span className="font-medium">Note:</span> {note}
                    </p>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  if (phase === "revision") {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black px-4 py-10">
        <div className="max-w-3xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
              Revision List
            </h1>
            <button
              onClick={() => setPhase("start")}
              className="rounded-full border border-zinc-300 dark:border-zinc-700 px-4 py-1.5 text-sm text-zinc-900 dark:text-zinc-50"
            >
              Back
            </button>
          </div>

          {savedQuestions.length === 0 ? (
            <p className="text-zinc-500 dark:text-zinc-400">No questions saved yet.</p>
          ) : (
            <div className="space-y-3">
              {savedQuestions.map(({ setName, question: q }) => (
                <div
                  key={`${setName}-${q.id}`}
                  className="bg-white dark:bg-zinc-900 rounded-xl shadow p-5"
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <p className="font-medium text-zinc-900 dark:text-zinc-50">
                      {q.id}. {q.question}
                    </p>
                    <button
                      onClick={() =>
                        persistSavedQuestions(
                          savedQuestions.filter(
                            (s) => !(s.setName === setName && s.question.id === q.id)
                          )
                        )
                      }
                      className="shrink-0 text-zinc-400 hover:text-red-600"
                      aria-label="Remove from revision list"
                    >
                      ✕
                    </button>
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">{setName}</p>
                  <div className="text-sm space-y-1">
                    {(Object.keys(q.options) as OptionKey[]).map((key) => {
                      const isRightAnswer = q.correctAnswer === key;
                      return (
                        <p
                          key={key}
                          className={
                            isRightAnswer
                              ? "text-green-600 font-semibold"
                              : "text-zinc-600 dark:text-zinc-400"
                          }
                        >
                          ({key}) {q.options[key]}
                          {isRightAnswer && " ✓"}
                        </p>
                      );
                    })}
                  </div>
                  {notes[noteKey(setName, q.id)] && (
                    <p className="mt-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
                      <span className="font-medium">Note:</span> {notes[noteKey(setName, q.id)]}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // results
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black px-4 py-10">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="bg-white dark:bg-zinc-900 rounded-xl shadow p-8 text-center space-y-2">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">Results</h1>
          <p className="text-4xl font-bold text-zinc-900 dark:text-zinc-50">
            {score.marks.toFixed(2)} <span className="text-lg font-normal text-zinc-500">/ {activeQuestions.length}</span>
          </p>
          <div className="flex justify-center gap-6 text-sm pt-2">
            <span className="text-green-600 font-medium">Correct: {score.correct}</span>
            <span className="text-red-600 font-medium">Wrong: {score.wrong}</span>
            <span className="text-zinc-500 font-medium">Skipped: {score.skipped}</span>
          </div>
          <button
            onClick={() => setPhase("start")}
            className="mt-4 rounded-full bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black px-6 py-2 font-medium"
          >
            Retake Test
          </button>
        </div>

        <div className="space-y-3">
          {activeQuestions.map((q) => {
            const a = answers[q.id];
            const isCorrect = a === q.correctAnswer;
            return (
              <div
                key={q.id}
                className="bg-white dark:bg-zinc-900 rounded-xl shadow p-5"
              >
                <p className="font-medium text-zinc-900 dark:text-zinc-50 mb-2">
                  {q.id}. {q.question}
                </p>
                <div className="text-sm space-y-1">
                  {(Object.keys(q.options) as OptionKey[]).map((key) => {
                    const isYourAnswer = a === key;
                    const isRightAnswer = q.correctAnswer === key;
                    let cls = "text-zinc-600 dark:text-zinc-400";
                    if (isRightAnswer) cls = "text-green-600 font-semibold";
                    else if (isYourAnswer && !isCorrect) cls = "text-red-600 font-semibold line-through";
                    return (
                      <p key={key} className={cls}>
                        ({key}) {q.options[key]}
                        {isRightAnswer && " ✓"}
                        {isYourAnswer && !isRightAnswer && " ✗ (your answer)"}
                      </p>
                    );
                  })}
                  {!a && <p className="text-zinc-400 italic">Not answered</p>}
                </div>
                {notes[noteKey(selectedSetName, q.id)] && (
                  <p className="mt-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
                    <span className="font-medium">Note:</span> {notes[noteKey(selectedSetName, q.id)]}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <QuizApp />
    </Suspense>
  );
}
