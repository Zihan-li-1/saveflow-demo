export type ClarificationChoice = {
  optionId: string;
  label: string;
};

export type ClarificationResult = {
  kind: "clarification";
  action: "transfer.create" | "bill.summary" | "card.get" | "card.set_budget" | "card.set_controls" | "card.security_review" | "card.freeze" | "card.unfreeze" | "clarify";
  question: string;
  slot?: string;
  choices: ClarificationChoice[];
  continuationToken: string;
};
