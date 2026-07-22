import { IncidentPayload, Diagnosis } from './types.js';

export interface PlannerOutput {
  diagnosis: Diagnosis;
  diagnosticCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
    evidence: string[];
  }>;
  suggestedEffect: {
    toolName: string;
    arguments: Record<string, any>;
  };
}

export async function runModelPlanner(payload: IncidentPayload): Promise<PlannerOutput> {
  const token = process.env.AIPIPE_TOKEN;
  if (!token) {
    throw new Error("AIPIPE_TOKEN environment variable is not set.");
  }

  const systemPrompt = `You are an incident response agent. Analyze the provided incident transcript and tool catalog.
Return ONLY a valid JSON object matching this schema without markdown formatting:
{
  "diagnosis": {
    "rootCause": "<exact cause from allowedRootCauses>",
    "evidence": ["<evidenceId_1>", "<evidenceId_2>"]
  },
  "diagnosticCalls": [
    {
      "toolName": "<toolName>",
      "arguments": { ... },
      "evidence": ["<evidenceId_1>"]
    }
  ],
  "suggestedEffect": {
    "toolName": "<effectToolName>",
    "arguments": { ... }
  }
}

Rules:
1. rootCause MUST be chosen from allowedRootCauses.
2. evidence MUST cite 2 to 4 evidence line IDs found in brackets in transcript (e.g., "ev_101").
3. Include 1 to ${payload.policy.maximumDiagnostics} diagnostic tool calls. Every diagnostic dispatch must cite at least one evidence ID from diagnosis.evidence.
4. suggestedEffect MUST be one effect tool from toolCatalog to fix the root cause.`;

  const userContent = `
Allowed Root Causes:
${JSON.stringify(payload.incident.allowedRootCauses)}

Tool Catalog:
${JSON.stringify(payload.toolCatalog, null, 2)}

Incident Title: ${payload.incident.title}
Service: ${payload.incident.service}
Transcript:
${payload.incident.transcript}
`;

  const modelName = process.env.MODEL_NAME || "openai/gpt-4.1-nano";

  const response = await fetch("https://aipipe.org/openrouter/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ],
      temperature: 0.0
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI Pipe Error (${response.status}): ${errorText}`);
  }

  const json: any = await response.json();
  const rawContent = json.choices?.[0]?.message?.content || "";
  const cleanJson = rawContent.replace(/```json/gi, "").replace(/```/g, "").trim();

  return JSON.parse(cleanJson);
}
