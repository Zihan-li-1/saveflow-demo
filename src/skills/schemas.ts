
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
      /** Reserved target contract only; not registered or callable this round.
       * subscription.cancel was an obsolete draft name, not a merchant membership cancellation capability. */
      action: "subscription.cancel_debit";
      subscriptionId: string;
      mandateId?: string;
    };

export type BillSkillAction =
  | BillAction
  | SubscriptionAction;
