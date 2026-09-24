import {
  PARSED_INTENT_ACTIONS as runtimeActions,
  PARSED_INTENT_SCHEMA_VERSION as runtimeSchemaVersion,
  ParsedIntentValidationError as RuntimeParsedIntentValidationError,
  isParsedIntent as runtimeIsParsedIntent,
  validateParsedIntent as runtimeValidateParsedIntent,
} from "./validate-parsed-intent.mjs";
import type { ParsedIntent } from "./parsed-intent";

/** TypeScript facade for the Node runtime implementation in validate-parsed-intent.mjs. */
export const PARSED_INTENT_SCHEMA_VERSION: typeof runtimeSchemaVersion = runtimeSchemaVersion;
export const PARSED_INTENT_ACTIONS: typeof runtimeActions = runtimeActions;
export const ParsedIntentValidationError = RuntimeParsedIntentValidationError;

export function validateParsedIntent(value: unknown): ParsedIntent {
  return runtimeValidateParsedIntent(value) as ParsedIntent;
}

export function isParsedIntent(value: unknown): value is ParsedIntent {
  return runtimeIsParsedIntent(value);
}
