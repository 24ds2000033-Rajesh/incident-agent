import { StoredState } from './types.js';

export function buildOtlpTrace(state: StoredState): any {
  const agentSpanId = state.runId.slice(0, 16).padStart(16, 'a');
  const traceId = state.traceId;
  const now = Date.now() * 1000000;

  const defaultAttrs = [
    { key: "ga5.run.id", value: { stringValue: state.runId } },
    { key: "ga5.public.marker", value: { stringValue: state.publicMarker } }
  ];

  const spans: any[] = [];

  // 1. SERVER Span
  spans.push({
    traceId,
    spanId: agentSpanId,
    parentSpanId: state.parentSpanId || "",
    name: "POST /v2/incidents",
    kind: 2, // SERVER
    startTimeUnixNano: state.startTimeUnixNano,
    endTimeUnixNano: now,
    attributes: [...defaultAttrs]
  });

  // 2. INTERNAL invoke_agent
  const invokeSpanId = "inv_" + agentSpanId.slice(4);
  spans.push({
    traceId,
    spanId: invokeSpanId,
    parentSpanId: agentSpanId,
    name: "invoke_agent incident-response",
    kind: 1, // INTERNAL
    startTimeUnixNano: state.startTimeUnixNano + 1000,
    endTimeUnixNano: now - 1000,
    attributes: [...defaultAttrs]
  });

  // 3. CLIENT chat incident-plan
  const chatSpanId = "chat_" + agentSpanId.slice(5);
  spans.push({
    traceId,
    spanId: chatSpanId,
    parentSpanId: invokeSpanId,
    name: "chat incident-plan",
    kind: 3, // CLIENT
    startTimeUnixNano: state.modelStartTimeUnixNano || (state.startTimeUnixNano + 2000),
    endTimeUnixNano: state.modelEndTimeUnixNano || (state.startTimeUnixNano + 500000),
    attributes: [
      ...defaultAttrs,
      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
      { key: "gen_ai.request.model", value: { stringValue: process.env.MODEL_NAME || "openai/gpt-4.1-nano" } }
    ]
  });

  const diagnosticActionIds: string[] = [];

  // 4. Executed Tool Spans
  for (const dispatch of state.actionLog) {
    const logicalSpanId = dispatch.actionId.slice(0, 16).padStart(16, 'b');
    if (dispatch.phase === "diagnostic") {
      diagnosticActionIds.push(logicalSpanId);
    }

    spans.push({
      traceId,
      spanId: logicalSpanId,
      parentSpanId: invokeSpanId,
      name: `execute_tool ${dispatch.toolName}`,
      kind: 1, // INTERNAL
      startTimeUnixNano: state.startTimeUnixNano + 10000,
      endTimeUnixNano: now - 5000,
      attributes: [
        ...defaultAttrs,
        { key: "ga5.action.id", value: { stringValue: dispatch.actionId } },
        { key: "gen_ai.tool.name", value: { stringValue: dispatch.toolName } },
        { key: "gen_ai.tool.call.id", value: { stringValue: dispatch.callId } },
        { key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } }
      ]
    });

    const attemptsInfo = state.toolSpans.get(dispatch.actionId) || [];
    for (const att of attemptsInfo) {
      const clientAttrs: any[] = [
        ...defaultAttrs,
        { key: "ga5.action.id", value: { stringValue: dispatch.actionId } },
        { key: "ga5.attempt", value: { intValue: att.attempt } },
        { key: "http.request.method", value: { stringValue: "POST" } },
        { key: "http.request.resend_count", value: { intValue: att.attempt - 1 } }
      ];

      if (att.receiptId) {
        clientAttrs.push({ key: "ga5.receipt.id", value: { stringValue: att.receiptId } });
      }
      if (att.receiptNonce) {
        clientAttrs.push({ key: "ga5.receipt.nonce", value: { stringValue: att.receiptNonce } });
      }

      const statusObj: any = {};
      if (att.status === 503) {
        statusObj.code = 2; // ERROR
        clientAttrs.push({ key: "error.type", value: { stringValue: "503" } });
      } else if (att.errorType === "timeout") {
        statusObj.code = 2; // ERROR
        clientAttrs.push({ key: "error.type", value: { stringValue: "timeout" } });
      } else {
        statusObj.code = 1; // OK
      }

      spans.push({
        traceId,
        spanId: att.clientSpanId,
        parentSpanId: logicalSpanId,
        name: `POST tool/${dispatch.toolName}`,
        kind: 3, // CLIENT
        startTimeUnixNano: att.startTimeNano,
        endTimeUnixNano: att.endTimeNano,
        status: statusObj,
        attributes: clientAttrs
      });
    }
  }

  // 5. INTERNAL incident.join
  if (diagnosticActionIds.length > 1) {
    const joinSpanId = "join_" + agentSpanId.slice(5);
    spans.push({
      traceId,
      spanId: joinSpanId,
      parentSpanId: invokeSpanId,
      name: "incident.join",
      kind: 1, // INTERNAL
      startTimeUnixNano: now - 4000,
      endTimeUnixNano: now - 3000,
      links: diagnosticActionIds.map(sId => ({ traceId, spanId: sId })),
      attributes: [...defaultAttrs]
    });
  }

  // 6. INTERNAL approval_gate
  for (const r of state.receiptLog) {
    if (r.approvalId) {
      const appSpanId = "appr_" + r.approvalId.slice(0, 11).padStart(11, 'c');
      spans.push({
        traceId,
        spanId: appSpanId,
        parentSpanId: invokeSpanId,
        name: "approval_gate",
        kind: 1, // INTERNAL
        startTimeUnixNano: now - 2000,
        endTimeUnixNano: now - 1000,
        attributes: [
          ...defaultAttrs,
          { key: "ga5.approval.id", value: { stringValue: r.approvalId } },
          { key: "ga5.receipt.nonce", value: { stringValue: r.nonce } }
        ]
      });
    }
  }

  return {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans
          }
        ]
      }
    ]
  };
}
