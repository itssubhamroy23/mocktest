export type OptionKey = "A" | "B" | "C" | "D";

export type Question = {
  id: number;
  question: string;
  options: Record<OptionKey, string>;
  correctAnswer: OptionKey;
};
