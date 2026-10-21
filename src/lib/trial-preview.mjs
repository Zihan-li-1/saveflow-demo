// This namespace is permanently reserved, regardless of feature flags or process restarts.
export const isTrialOperationId = value => typeof value === 'string' && value.startsWith('tfpreview:');
export const isTrialPreview = data => !!data && (data.previewOnly === true || data.source === 'trueforge-mcp' || isTrialOperationId(data.operationId));
