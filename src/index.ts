import http from 'http';
import { 
  IncidentPayload, StoredState, Dispatch, OutcomeReceipt, ApprovalRequest 
} from './types.js';
import { 
  computeSHA256Hex, generateRandomHex, parseTraceparent, formatTraceparent, getCurrentUnixNano 
} from './utils.js';
import { runModelPlanner } from './planner.js';
import { buildOtlpTrace } from './traceBuilder.js';

const stateStore = new Map<string, StoredState>();
const receiptStore = new Map<string, string>();

function sendJsonResponse(res: http.ServerResponse, statusCode: number, data: any) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function cleanResponse(state: StoredState) {
  const otlp = buildOtlpTrace(state);

  if (state.status === "completed" || state.status === "failed") {
    return {
      runId: state.runId,
      status: state.status,
      diagnosis: state.diagnosis,
      chosenEffect: state.chosenEffect,
      suppressed: state.suppressed,
      actionLog: state.actionLog,
      receiptLog: state.receiptLog,
      otlp
    };
  }

  return {
    runId: state.runId,
    status: state.status,
    diagnosis: state.diagnosis,
    dispatches: state.dispatches,
    approvals: state.approvals
  };
}

const server = http.createServer(async (req, res) => {
  const urlParts = req.url?.split('/') || [];
  const method = req.method;

  let bodyText = '';
  req.on('data', chunk => { bodyText += chunk; });
  req.on('end', async () => {
    try {
      // POST /v2/incidents
      if (method === 'POST' && req.url === '/v2/incidents') {
        let payload: IncidentPayload;
        try {
          payload = JSON.parse(bodyText);
        } catch {
          return sendJsonResponse(res, 400, { error: "Invalid JSON body" });
        }

        // Profile validation probe test
        if (payload.profile !== "ga5-incident-agent/v2") {
          return sendJsonResponse(res, 422, { error: "Unsupported profile" });
        }

        if (!payload.runId || !payload.incident || !payload.policy) {
          return sendJsonResponse(res, 400, { error: "Missing required incident fields" });
        }

        const incomingHash = computeSHA256Hex(payload);

        if (stateStore.has(payload.runId)) {
          const existing = stateStore.get(payload.runId)!;
          if (existing.incomingHash !== incomingHash) {
            return sendJsonResponse(res, 409, { error: "Conflict: runId exists with different payload" });
          }
          return sendJsonResponse(res, 200, cleanResponse(existing));
        }

        const startNano = getCurrentUnixNano();
        const traceCtx = parseTraceparent(req.headers['traceparent'] as string);

        const modelStart = getCurrentUnixNano();
        const plan = await runModelPlanner(payload);
        const modelEnd = getCurrentUnixNano();

        const pendingDiagnostics = new Map();
        const dispatches: Dispatch[] = [];

        plan.diagnosticCalls.slice(0, payload.policy.maximumDiagnostics).forEach((call, idx) => {
          const actionId = `act_diag_${payload.runId.slice(0, 8)}_${idx}_${generateRandomHex(8)}`;
          const callId = `call_diag_${payload.runId.slice(0, 8)}_${idx}_${generateRandomHex(8)}`;
          const clientSpanId = generateRandomHex(16);

          pendingDiagnostics.set(actionId, {
            callId,
            toolName: call.toolName,
            arguments: call.arguments,
            evidence: call.evidence
          });

          const traceparent = formatTraceparent(traceCtx.traceId, clientSpanId);

          const dispatch: Dispatch = {
            actionId,
            callId,
            phase: "diagnostic",
            toolName: call.toolName,
            arguments: call.arguments,
            evidence: Array.from(new Set(call.evidence)),
            attempt: 1,
            traceparent
          };

          dispatches.push(dispatch);
        });

        const state: StoredState = {
          runId: payload.runId,
          profile: payload.profile,
          publicMarker: payload.publicMarker,
          status: "waiting",
          diagnosis: plan.diagnosis,
          suppressed: [],
          dispatches,
          approvals: [],
          actionLog: [...dispatches],
          receiptLog: [],
          policy: payload.policy,
          toolCatalog: payload.toolCatalog,
          pendingDiagnosticActions: pendingDiagnostics,
          completedDiagnostics: new Map(),
          pendingEffect: plan.suggestedEffect ? {
            actionId: `act_eff_${payload.runId.slice(0, 8)}_${generateRandomHex(8)}`,
            toolName: plan.suggestedEffect.toolName,
            arguments: plan.suggestedEffect.arguments
          } : undefined,
          traceId: traceCtx.traceId,
          parentSpanId: traceCtx.parentSpanId,
          startTimeUnixNano: startNano,
          modelStartTimeUnixNano: modelStart,
          modelEndTimeUnixNano: modelEnd,
          toolSpans: new Map(),
          incomingHash
        };

        for (const d of dispatches) {
          const clientSpanId = d.traceparent.split('-')[2];
          state.toolSpans.set(d.actionId, [{
            attempt: 1,
            clientSpanId,
            startTimeNano: startNano + 100000,
            endTimeNano: startNano + 200000,
            status: 0
          }]);
        }

        stateStore.set(payload.runId, state);
        return sendJsonResponse(res, 200, cleanResponse(state));
      }

      // POST /v2/incidents/{runId}/receipts
      if (method === 'POST' && urlParts[2] === 'incidents' && urlParts[4] === 'receipts') {
        const runId = urlParts[3];
        const state = stateStore.get(runId);
        if (!state) {
          return sendJsonResponse(res, 404, { error: "Run not found" });
        }

        let receiptPayload: OutcomeReceipt;
        try {
          receiptPayload = JSON.parse(bodyText);
        } catch {
          return sendJsonResponse(res, 400, { error: "Invalid receipt JSON" });
        }

        const receiptHash = computeSHA256Hex(receiptPayload);

        if (receiptStore.has(receiptPayload.receiptId)) {
          if (receiptStore.get(receiptPayload.receiptId) !== receiptHash) {
            return sendJsonResponse(res, 409, { error: "Conflict: receiptId exists with different payload" });
          }
          return sendJsonResponse(res, 200, cleanResponse(state));
        }
        receiptStore.set(receiptPayload.receiptId, receiptHash);

        if (receiptPayload.outcomes) {
          for (const outcome of receiptPayload.outcomes) {
            state.receiptLog.push({
              receiptId: receiptPayload.receiptId,
              actionId: outcome.actionId,
              callId: outcome.callId,
              attempt: outcome.attempt,
              status: outcome.status,
              resultClass: outcome.resultClass,
              nonce: outcome.nonce
            });

            const attempts = state.toolSpans.get(outcome.actionId) || [];
            const lastAtt = attempts[attempts.length - 1];
            if (lastAtt) {
              lastAtt.status = outcome.status;
              lastAtt.receiptId = receiptPayload.receiptId;
              lastAtt.receiptNonce = outcome.nonce;
              lastAtt.errorType = outcome.errorType;
              lastAtt.endTimeNano = getCurrentUnixNano();
            }

            if (outcome.status === 503 && outcome.attempt === 1) {
              const prevDispatch = state.actionLog.find(a => a.actionId === outcome.actionId);
              if (prevDispatch) {
                const nextClientSpanId = generateRandomHex(16);
                const retryDispatch: Dispatch = {
                  ...prevDispatch,
                  attempt: 2,
                  traceparent: formatTraceparent(state.traceId, nextClientSpanId)
                };
                state.dispatches = [retryDispatch];
                state.actionLog.push(retryDispatch);
                attempts.push({
                  attempt: 2,
                  clientSpanId: nextClientSpanId,
                  startTimeNano: getCurrentUnixNano(),
                  endTimeNano: getCurrentUnixNano() + 100000,
                  status: 0
                });
                return sendJsonResponse(res, 200, cleanResponse(state));
              }
            }

            if (outcome.status === 0 || outcome.errorType === "timeout") {
              state.status = "failed";
              state.dispatches = [];
              state.approvals = [];
              return sendJsonResponse(res, 200, cleanResponse(state));
            }

            if (state.pendingDiagnosticActions.has(outcome.actionId)) {
              state.completedDiagnostics.set(outcome.actionId, {
                resultClass: outcome.resultClass,
                status: outcome.status
              });
              state.pendingDiagnosticActions.delete(outcome.actionId);
            }
          }
        }

        if (receiptPayload.approvals) {
          for (const app of receiptPayload.approvals) {
            state.receiptLog.push({
              receiptId: receiptPayload.receiptId,
              approvalId: app.approvalId,
              decision: app.decision,
              nonce: app.nonce
            });

            if (app.decision === "approved" && state.pendingEffect) {
              const nextClientSpanId = generateRandomHex(16);
              const effectDispatch: Dispatch = {
                actionId: state.pendingEffect.actionId,
                callId: `call_eff_${generateRandomHex(8)}`,
                phase: "effect",
                toolName: state.pendingEffect.toolName,
                arguments: state.pendingEffect.arguments,
                attempt: 1,
                traceparent: formatTraceparent(state.traceId, nextClientSpanId),
                approvalId: app.approvalId,
                approvalNonce: app.nonce
              };

              state.dispatches = [effectDispatch];
              state.actionLog.push(effectDispatch);
              state.approvals = [];
              state.chosenEffect = state.pendingEffect.toolName;
              state.toolSpans.set(effectDispatch.actionId, [{
                attempt: 1,
                clientSpanId: nextClientSpanId,
                startTimeNano: getCurrentUnixNano(),
                endTimeNano: getCurrentUnixNano() + 100000,
                status: 0
              }]);

              return sendJsonResponse(res, 200, cleanResponse(state));
            }
          }
        }

        if (state.pendingDiagnosticActions.size === 0 && state.status === "waiting") {
          if (state.pendingEffect) {
            const toolName = state.pendingEffect.toolName;
            const requiresApproval = state.policy.approvalRequiredFor.includes(toolName);

            if (requiresApproval) {
              const approvalId = `app_${generateRandomHex(12)}`;
              const digest = computeSHA256Hex(state.pendingEffect.arguments);

              const approvalReq: ApprovalRequest = {
                approvalId,
                actionId: state.pendingEffect.actionId,
                toolName,
                argumentsDigest: digest,
                arguments: state.pendingEffect.arguments
              };

              state.dispatches = [];
              state.approvals = [approvalReq];
              return sendJsonResponse(res, 200, cleanResponse(state));
            } else {
              const nextClientSpanId = generateRandomHex(16);
              const effectDispatch: Dispatch = {
                actionId: state.pendingEffect.actionId,
                callId: `call_eff_${generateRandomHex(8)}`,
                phase: "effect",
                toolName,
                arguments: state.pendingEffect.arguments,
                attempt: 1,
                traceparent: formatTraceparent(state.traceId, nextClientSpanId)
              };

              state.dispatches = [effectDispatch];
              state.actionLog.push(effectDispatch);
              state.chosenEffect = toolName;
              state.toolSpans.set(effectDispatch.actionId, [{
                attempt: 1,
                clientSpanId: nextClientSpanId,
                startTimeNano: getCurrentUnixNano(),
                endTimeNano: getCurrentUnixNano() + 100000,
                status: 0
              }]);

              return sendJsonResponse(res, 200, cleanResponse(state));
            }
          } else {
            state.status = "completed";
            state.dispatches = [];
            state.approvals = [];
          }
        }

        return sendJsonResponse(res, 200, cleanResponse(state));
      }

      // GET /v2/incidents/{runId}
      if (method === 'GET' && urlParts[2] === 'incidents' && urlParts[3]) {
        const runId = urlParts[3];
        const state = stateStore.get(runId);
        if (!state) {
          return sendJsonResponse(res, 404, { error: "Run not found" });
        }
        return sendJsonResponse(res, 200, cleanResponse(state));
      }

      sendJsonResponse(res, 404, { error: "Endpoint not found" });
    } catch (err: any) {
      sendJsonResponse(res, 500, { error: err.message || "Internal Error" });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Incident Response Agent active on port ${PORT}`);
});
