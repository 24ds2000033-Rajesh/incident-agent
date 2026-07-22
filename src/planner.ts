import { GoogleGenAI } from '@google/genai';
import { IncidentPayload, Diagnosis } from './types.js';

const ai = new GoogleGenAI({});

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
  // Safe prompt stripped of sensitive context
  const prompt = `
You are an expert site reliability engineer. Analyze the following incident transcript.

Allowed Root Causes:
${JSON.stringify(payload.incident.allowedRootCauses)}

Tool Catalog:
${JSON.stringify(payload.toolCatalog, null, 2)}

Max Diagnostics Allowed: ${payload.policy.maximumDiagnostics}

Incident Title: ${payload.incident.title}
Service: ${payload.incident.service}
Transcript:
${payload.incident.transcript}

Instructions:
1. Identify the SINGLE correct root cause from allowedRootCauses.
2. Extract 2 to 4 evidence line IDs (e.g. "ev_123", "ev_456") directly supporting this diagnosis.
3. Select 1 to ${payload.policy.maximumDiagnostics} DIAGNOSTIC tools from the catalog to confirm this diagnosis. Each diagnostic call must cite at least one of the selected evidence IDs. Do NOT issue redundant calls. Use exact incident-specific arguments based on transcript details.
4. Select 1 EFFECT tool from the tool catalog that resolves the root cause.

Return ONLY a valid JSON object with the following structure (no markdown fences):
{
  "diagnosis": {
    "rootCause": "<allowed value>",
    "evidence": ["ev_1", "ev_2"]
  },
  "diagnosticCalls": [
    {
      "toolName": "<diagnostic_tool_name>",
      "arguments": { ... },
      "evidence": ["ev_1"]
    }
  ],
  "suggestedEffect": {
    "toolName": "<effect_tool_name>",
    "arguments": { ... }
  }
}
`;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.0,
    }
  });

  const text = response.text || '';
  const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleanJson);

  return parsed;
}
