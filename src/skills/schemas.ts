
export type BillAction =
  | {
      action: "bill.list";
      accountId?: string;
      month?: string;
    }
  | {
      action: "bill.summary";
      accountId?: string;
      month?: string;
    };

export type SubscriptionAction =
  | {
      action: "subscription.list";
    }
  | {
      action: "subscription.find_unused";
    }
  | {
      action: "subscription.cancel";
      subscriptionId: string;
      mandateId?: string;
    };

export type BillSkillAction =
  | BillAction
  | SubscriptionAction;
  