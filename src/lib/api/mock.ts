import { legacyRequest } from "../../banking-core/legacy-adapter.mjs";
import { BankingError } from "../../banking-core/errors.mjs";
import { ApiError, type Action, type RequestMap, type ResultMap } from "./contracts";

// Compatibility only: Banking Core owns all operation records.
export function mockRequest<A extends Action>(action: A, input: RequestMap[A], operationId: string): ResultMap[A] {
  try { return legacyRequest(action, input, operationId) as ResultMap[A]; }
  catch (error) {
    if (error instanceof BankingError) throw new ApiError(error.code, error.message, error.uncertain);
    throw error;
  }
}
