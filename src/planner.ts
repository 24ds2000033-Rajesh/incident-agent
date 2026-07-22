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
Return ONLY valid JSON matching this schema:
{
  "diagnosis": {
    "rootCause": "<string from allowedRootCauses>",
    "evidence": ["<evidenceId_1>", "<evidenceId_2>"]
  },
  "diagnosticCalls": [
    {
      "toolName": "<toolName>",
      "arguments": { ... },
      "evidence": ["<evidenceId>"]
    }
  ],
  "suggestedEffect": {
    "toolName": "<effectToolName>",
    "arguments": { ... }
  }
}

Constraints:
1. rootCause MUST be chosen from allowedRootCauses.
2. evidence MUST cite 2 to 4 distinct evidence line IDs from the transcript (e.g. "ev_123").
3. Include at most ${payload.policy.maximumDiagnostics} diagnostic tool calls. Each diagnostic call must cite at least one evidence ID.
4. suggestedEffect MUST be one effect tool from toolCatalog to fix the issue. Do NOT include markdown blocks.`;

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

  // Model choice: openai/gpt-4.1-nano or openai/gpt-4o-mini via AI Pipe
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
      response_format: { type: "json_object" },
      temperature: 0.0
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI Pipe Error (${response.status}): ${errorText}`);
  }

  const json: any = await response.json();
  const rawContent = json.choices?.[0]?.message?.content || "";
  const cleanJson = rawContent.replace(/```json/g, "").replace(/```/g, "").trim();

  return JSON.parse(cleanJson);
}
