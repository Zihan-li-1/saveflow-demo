import type { ActionResult, ActionState, OperationStatus } from '../src/banking-core/contracts';
import type { ParsedIntent } from '../src/agent/parsed-intent';

export type TaskStatus = 'ready' | 'awaiting_input' | 'awaiting_confirmation' | 'suspended' | 'completed' | 'cancelled' | 'failed' | 'expired';
export type TrustedTaskSummary = {
  action: string;
  status: TaskStatus;
  pendingSlots: string[];
  verifiedContext?: Record<string, unknown>;
  operationStates?: ActionState[];
};
export type TrustedTaskContext = {
  currentTask: TrustedTaskSummary | null;
  previousTasks: TrustedTaskSummary[];
  recentResults: Array<{ action: string; status: Extract<ActionState, 'succeeded' | 'failed' | 'cancelled'> }>;
};
export type TaskControlProposal = {
  kind: 'task_control';
  control: { command: 'cancel' | 'undo' | 'modify' | 'resume'; target: 'current' | 'previous' };
};
export type ConversationTask = {
  taskId: string;
  action: string;
  status: TaskStatus;
  resumeStatus: 'ready' | 'awaiting_input' | 'awaiting_confirmation' | null;
  verifiedSlots: Record<string, unknown>;
  pendingSlots: string[];
  continuationExpiresAt: number;
  latestContinuationId: string | null;
  previewOperationId: string | null;
  operationReferences: string[];
  revision: number;
  createdAt: number;
  updatedAt: number;
};
export type PreviewReference = {
  operationId: string;
  taskId: string;
  previewHash: string;
  stepIds: string[];
  expiresAt: number;
  coreState: ActionState;
};
export type OperationReference = PreviewReference & { action: string; observedAt: number };
export type ConversationState = {
  conversationId: string;
  currentTask: ConversationTask | null;
  suspendedTasks: ConversationTask[];
  /** Projection of the current live task; never an execution authorization. */
  verifiedSlots: Record<string, unknown>;
  pendingPreview: PreviewReference | null;
  operationReferences: OperationReference[];
  revision: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};
export type ConversationCommand =
  | { type: 'start_task'; intent: ParsedIntent; continuationExpiresAt?: number; suspendCurrent?: boolean }
  | { type: 'update_task'; taskId: string; intent: ParsedIntent; continuationExpiresAt?: number }
  | { type: 'suspend_task'; taskId: string }
  | { type: 'resume_task'; taskId: string; suspendCurrent?: boolean }
  | { type: 'end_task'; taskId: string; outcome: 'completed' | 'cancelled' }
  | { type: 'set_continuation'; taskId: string; tokenId: string; expiresAt: number; pendingSlot?: string; awaitingInput: boolean }
  | { type: 'attach_preview'; taskId: string; operationId: string }
  | { type: 'observe_operation'; operationId: string };
export interface ConversationStore {
  create(): { conversationToken: string; state: ConversationState };
  read(conversationToken: string): ConversationState;
  transition(conversationToken: string, expectedRevision: number, command: ConversationCommand): Promise<ConversationState>;
  cleanup(): { conversationsRemoved: number; tasksExpired: number };
}
export type ConversationStoreOptions = {
  now?: () => number;
  ttlMs?: number;
  taskTtlMs?: number;
  maxTaskTtlMs?: number;
  maxConversations?: number;
  maxTasks?: number;
  maxOperations?: number;
  /** Inject a server-owned, authenticated Core reader. No prepare/decide/execute capability. */
  readCoreOperation?: (operationId: string) => Promise<ActionResult<OperationStatus>>;
};

// Include the JS implementation in the normal project typecheck as well.
export type InMemoryConversationStore = ReturnType<typeof import('./conversation-state.mjs').createConversationStore>;
