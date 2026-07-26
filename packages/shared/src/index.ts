import { z } from "zod";

// Парсеры единиц измерения и схема политики — часть контракта, поэтому живут здесь же.
export * from "./units.js";
export * from "./policy.js";

export const nodeLabelsSchema = z.record(z.string(), z.string());

export const nodeIdentitySchema = z.object({
  nodeId: z.string().min(1),
  hostname: z.string().min(1),
  agentVersion: z.string().optional(),
  labels: nodeLabelsSchema.default({})
});

export const metricSnapshotSchema = z.object({
  node: nodeIdentitySchema,
  collectedAt: z.string().datetime(),
  uptimeSeconds: z.number().nonnegative(),
  cpu: z.object({
    usagePercent: z.number().min(0).max(100),
    loadAverage: z.array(z.number().nonnegative()).length(3).optional()
  }),
  memory: z.object({
    totalBytes: z.number().positive(),
    usedBytes: z.number().nonnegative(),
    usagePercent: z.number().min(0).max(100)
  }),
  disk: z.object({
    mountPoint: z.string().min(1),
    totalBytes: z.number().positive(),
    usedBytes: z.number().nonnegative(),
    usagePercent: z.number().min(0).max(100)
  })
});

export const scalingDecisionSchema = z.object({
  /** Имя политики из файла конфигурации. В БД хранится в колонке policy_id. */
  policyName: z.string(),
  shouldScale: z.boolean(),
  reason: z.string(),
  observedNodes: z.number().int().nonnegative(),
  averages: z.object({
    cpuPercent: z.number().min(0).max(100).nullable(),
    memoryPercent: z.number().min(0).max(100).nullable(),
    diskPercent: z.number().min(0).max(100).nullable()
  }),
  evaluatedAt: z.string().datetime()
});

export const scalingEventSchema = z.object({
  id: z.string(),
  policyName: z.string(),
  status: z.enum(["pending", "running", "succeeded", "failed", "dry_run"]),
  reason: z.string(),
  proxmoxTaskId: z.string().optional(),
  createdVmId: z.number().int().positive().optional(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional()
});

export type NodeLabels = z.infer<typeof nodeLabelsSchema>;
export type NodeIdentity = z.infer<typeof nodeIdentitySchema>;
export type MetricSnapshot = z.infer<typeof metricSnapshotSchema>;
export type ScalingDecision = z.infer<typeof scalingDecisionSchema>;
export type ScalingEvent = z.infer<typeof scalingEventSchema>;

export function labelsMatch(required: NodeLabels, actual: NodeLabels): boolean {
  return Object.entries(required).every(([key, value]) => actual[key] === value);
}
