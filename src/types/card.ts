// types/card.ts
/**
 * SaveFlow 卡片组件类型定义（阶段一）
 *
 * 约定：
 * 1. 本文件仅定义 UI 渲染所需的 Props 类型，不包含任何网络请求、业务逻辑或状态跳转。
 * 2. 接口契约尚未最终定稿，字段名与结构以业务文档样例为准。
 *    标注了【待接口契约确认后修改字段名】的字段，在契约定稿后需同步调整本文件与对应组件。
 * 3. 所有按钮回调均为可选，按钮点击仅向上抛出事件，由上层父组件处理。
 */

/** 通用按钮回调：按钮点击仅向上抛出事件，无入参、无返回值 */
export type CardActionHandler = () => void;

/** 分类明细项（金额变化类，如「娱乐 +620」） */
export interface BillCategoryItem {
  /** 分类名称，如「娱乐」「购物」 */
  name: string;
  /** 分类变化金额（元），正数为增加、负数为减少 */
  changeAmount: number;
}

/** 账单分析卡片 Props（纯展示，无按钮） */
export interface BillAnalysisCardProps {
  /** 本月支出总额（元） */
  totalExpense: number;
  /** 环比变化金额（元），正数为增加、负数为减少 */
  momIncrease: number;
  /** 分类变化明细列表 */
  categories: readonly BillCategoryItem[];
  /** 当前数据集中的订阅项数；没有新增标记时不要伪装成“新增” */
  subscriptionCount: number;
}

/** 分类预算项 */
export interface CategoryBudgetItem {
  /** 分类名称，如「餐饮」「交通」 */
  name: string;
  /** 预算金额（元） */
  amount: number;
}

/** 储蓄计划卡片 Props */
export interface SavingPlanCardProps {
  /** 储蓄目标金额（元）【待接口契约确认后修改字段名】 */
  savingGoal: number;
  /** 每月建议储蓄金额（元）【待接口契约确认后修改字段名】 */
  monthlySaving: number;
  /** 分类预算列表【待接口契约确认后修改字段名】 */
  categoryBudgets: readonly CategoryBudgetItem[];
  /** 预计完成时间文案，如「2027年6月」【待接口契约确认后修改字段名】 */
  estimatedCompletion: string;
  /** 确认创建按钮回调【待接口契约确认后修改字段名】 */
  onConfirmCreate: CardActionHandler;
  /** 修改方案按钮回调【待接口契约确认后修改字段名】 */
  onModifyPlan: CardActionHandler;
  /** 取消按钮回调【待接口契约确认后修改字段名】 */
  onCancelPlan: CardActionHandler;
}

/** 卡片执行消费结果状态：over-limit=消费超限异常，normal=消费正常 */
export type CardExecuteStatus = 'over-limit' | 'normal' | 'insufficient-balance';

/** 卡片执行消费结果卡片 Props */
export interface CardExecuteCardProps {
  /** 卡片名称【待接口契约确认后修改字段名】 */
  cardName: string;
  /** 月度限额（元）【待接口契约确认后修改字段名】 */
  monthlyLimit: number;
  /** 本月已使用金额（元）【待接口契约确认后修改字段名】 */
  usedThisMonth: number;
  /** 本次消费金额（元）【待接口契约确认后修改字段名】 */
  currentConsumption: number;
  /** 本次自动储蓄金额（元） */
  savingAmount: number;
  /** 消费与储蓄合计扣款（元） */
  totalDebit: number;
  /** 处理结果描述文案，如「本次消费将超出月度限额」【待接口契约确认后修改字段名】 */
  resultDescription: string;
  /** 处理结果状态，用于区分超限异常与正常两种场景的样式【待接口契约确认后修改字段名】 */
  status: CardExecuteStatus;
  /** 是否需要用户确认；余额不足时可设为 false */
  requiresConfirmation?: boolean;
  /** 确认支付按钮回调【待接口契约确认后修改字段名】 */
  onConfirmPay: CardActionHandler;
  /** 取消按钮回调【待接口契约确认后修改字段名】 */
  onCancelPay: CardActionHandler;
}
