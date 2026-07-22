export interface IncidentPayload {
  profile: string;
  runId: string;
  agentName: string;
  publicMarker: string;
  sensitive?: Record<string, any>;
  incident: {
    incidentId: string;
    title: string;
    service: string;
    severity: string;
    transcript: string;
    allowedRootCauses: string[];
  };
  toolCatalog: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, any>;
  }>;
  policy: {
    maximumDiagnostics: number;
    effectTools: string[];
    approvalRequiredFor: string[];
    doNotExport: string[];
  };
}

export interface Diagnosis {
  rootCause: string;
  evidence: string[];
}

export interface Dispatch {
  actionId: string;
  callId: string;
  phase: "diagnostic" | "effect";
  toolName: string;
  arguments: Record<string, any>;
  evidence?: string[];
  attempt: number;
  traceparent: string;
  approvalId?: string;
  approvalNonce?: string;
}

export interface ApprovalRequest {
  approvalId: string;
  actionId: string;
  toolName: string;
  argumentsDigest: string;
  arguments: Record<string, any>;
}

export interface OutcomeReceipt {
  receiptId: string;
  outcomes?: Array<{
    actionId: string;
    callId: string;
    attempt: number;
    status: number;
    resultClass: string;
    nonce: string;
    errorType?: string;
  }>;
  approvals?: Array<{
    approvalId: string;
    decision: "approved" | "rejected";
    nonce: string;
  }>;
}

export interface StoredState {
  runId: string;
  profile: string;
  publicMarker: string;
  status: "waiting" | "completed" | "failed";
  diagnosis: Diagnosis;
  chosenEffect?: string;
  suppressed: any[];
  dispatches: Dispatch[];
  approvals: ApprovalRequest[];
  actionLog: Dispatch[];
  receiptLog: any[];
  
  // Internal execution state tracking
  policy: IncidentPayload["policy"];
  toolCatalog: IncidentPayload["toolCatalog"];
  pendingDiagnosticActions: Map<string, { callId: string; toolName: string; arguments: any; evidence: string[] }>;
  completedDiagnostics: Map<string, { resultClass: string; status: number }>;
  pendingEffect?: { actionId: string; toolName: string; arguments: any };
  
  // Trace context
  traceId: string;
  parentSpanId?: string;
  tracestate?: string;
  
  // Timing state for trace generation
  startTimeUnixNano: number;
  modelStartTimeUnixNano?: number;
  modelEndTimeUnixNano?: number;
  toolSpans: Map<string, Array<{
    attempt: number;
    clientSpanId: string;
    startTimeNano: number;
    endTimeNano: number;
    status: number;
    receiptId?: string;
    receiptNonce?: string;
    errorType?: string;
  }>>;
  
  // Original incoming payload hash for conflict detection
  incomingHash: string;
}
