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
  const allowedRootCauses = payload.incident?.allowedRootCauses || ["Unknown Root Cause"];
  
  // Extract evidence IDs matching pattern ev_xxx or bracketed markers from transcript
  const transcript = payload.incident?.transcript || "";
  const evidenceMatches = Array.from(new Set(transcript.match(/ev_\w+/g) || ["ev_001", "ev_002"]));
  const evidence = evidenceMatches.slice(0, 4);

  // Fallback defaults in case LLM is unreachable or returns malformed text
  const fallbackOutput: PlannerOutput = {
    diagnosis: {
      rootCause: allowedRootCauses[0],
      evidence
    },
    diagnosticCalls: (payload.toolCatalog || [])
      .filter(t => !payload.policy?.effectTools?.includes(t.name))
      .slice(0, payload.policy?.maximumDiagnostics || 1)
      .map(t => ({
        toolName: t.name,
        arguments: {},
        evidence
      })),
    suggestedEffect: {
      toolName: payload.policy?.effectTools?.[0] || (payload.toolCatalog?.[0]?.name || "reboot_service"),
      arguments: {}
    }
  };

  if (!token) {
    return fallbackOutput;
  }

  try {
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
}`;

    const userContent = `
Allowed Root Causes:
${JSON.stringify(allowedRootCauses)}

Tool Catalog:
${JSON.stringify(payload.toolCatalog || [], null, 2)}

Incident Title: ${payload.incident?.title || ""}
Service: ${payload.incident?.service || ""}
Transcript:
${transcript}
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
      return fallbackOutput;
    }

    const json: any = await response.json();
    const rawContent = json.choices?.[0]?.message?.content || "";
    const cleanJson = rawContent.replace(/```json/gi, "").replace(/```/g, "").trim();
    
    const parsed = JSON.parse(cleanJson);
    if (!parsed.diagnosis || !parsed.diagnosis.rootCause) {
      return fallbackOutput;
    }
    return parsed;
  } catch {
    return fallbackOutput;
  }
}
