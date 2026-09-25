export type ClarificationChoice = {
  optionId: string;
  label: string;
};

export type ClarificationResult = {
  kind: "clarification";
  action: "transfer.create" | "bill.summary" | "clarify";
  question: string;
  slot?: string;
  choices: ClarificationChoice[];
  continuationToken: string;
};
