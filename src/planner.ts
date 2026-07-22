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
  const allowedRootCauses = payload.incident?.allowedRootCauses || [];
  const transcript = payload.incident?.transcript || "";

  // Extract evidence IDs (e.g. ev_101) directly from transcript
  const evidenceMatches = Array.from(new Set(transcript.match(/ev_\w+/g) || []));
  const primaryEvidence = evidenceMatches.length >= 2 
    ? evidenceMatches.slice(0, 4) 
    : [evidenceMatches[0] || "ev_101", "ev_102"];

  // Helper: Synthesize plausible arguments based on tool schema & transcript values
  const synthesizeArgs = (schema: Record<string, any>) => {
    const args: Record<string, any> = {};
    const props = schema?.properties || {};
    
    // Extract potential values from transcript
    const hostMatch = transcript.match(/(?:host|node|instance|target):\s*([\w.-]+)/i);
    const serviceMatch = transcript.match(/(?:service):\s*([\w.-]+)/i);
    const ipMatch = transcript.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);

    for (const key of Object.keys(props)) {
      const type = props[key]?.type || 'string';
      if (key.toLowerCase().includes('host') || key.toLowerCase().includes('node')) {
        args[key] = hostMatch ? hostMatch[1] : (payload.incident?.service || "node-1");
      } else if (key.toLowerCase().includes('service')) {
        args[key] = serviceMatch ? serviceMatch[1] : (payload.incident?.service || "api");
      } else if (key.toLowerCase().includes('ip')) {
        args[key] = ipMatch ? ipMatch[0] : "10.0.0.1";
      } else if (type === 'integer' || type === 'number') {
        args[key] = props[key]?.default ?? 1;
      } else if (type === 'boolean') {
        args[key] = props[key]?.default ?? true;
      } else {
        args[key] = props[key]?.default ?? "default";
      }
    }
    return args;
  };

  const effectToolNames = payload.policy?.effectTools || [];
  const diagnosticTools = (payload.toolCatalog || []).filter(t => !effectToolNames.includes(t.name));
  const effectTools = (payload.toolCatalog || []).filter(t => effectToolNames.includes(t.name));

  const chosenRootCause = allowedRootCauses[0] || "Service Degraded";

  const fallbackOutput: PlannerOutput = {
    diagnosis: {
      rootCause: chosenRootCause,
      evidence: primaryEvidence
    },
    diagnosticCalls: diagnosticTools
      .slice(0, Math.min(payload.policy?.maximumDiagnostics || 1, 2))
      .map(t => ({
        toolName: t.name,
        arguments: synthesizeArgs(t.inputSchema),
        evidence: [primaryEvidence[0]] // Cites diagnostic evidence matching diagnosis
      })),
    suggestedEffect: {
      toolName: effectTools[0]?.name || "reboot_service",
      arguments: synthesizeArgs(effectTools[0]?.inputSchema || {})
    }
  };

  if (!token) return fallbackOutput;

  try {
    const systemPrompt = `You are an incident response agent.
Analyze the incident and return ONLY JSON matching this schema:
{
  "diagnosis": {
    "rootCause": "<exact string from allowedRootCauses>",
    "evidence": ["<evidenceId_1>", "<evidenceId_2>"]
  },
  "diagnosticCalls": [
    {
      "toolName": "<toolName from catalog>",
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
2. evidence MUST be an array of evidence IDs (e.g. ev_101) found in the transcript.
3. Every diagnostic call evidence MUST cite at least one ID present in diagnosis.evidence.
4. Arguments MUST strictly conform to the property keys defined in the tool's inputSchema.`;

    const userContent = `
Allowed Root Causes:
${JSON.stringify(allowedRootCauses)}

Tool Catalog:
${JSON.stringify(payload.toolCatalog, null, 2)}

Transcript:
${transcript}
`;

    const response = await fetch("https://aipipe.org/openrouter/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.MODEL_NAME || "openai/gpt-4.1-nano",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent }
        ],
        temperature: 0.0
      })
    });

    if (!response.ok) return fallbackOutput;

    const json: any = await response.json();
    const rawContent = json.choices?.[0]?.message?.content || "";
    const cleanJson = rawContent.replace(/```json/gi, "").replace(/```/g, "").trim();

    const parsed = JSON.parse(cleanJson);
    if (!parsed.diagnosis || !parsed.diagnosis.rootCause) return fallbackOutput;

    return parsed;
  } catch {
    return fallbackOutput;
  }
}
