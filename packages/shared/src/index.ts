import { z } from "zod";

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

export const scalingPolicySchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  sampleIntervalSeconds: z.number().int().positive().default(15),
  evaluationWindowSeconds: z.number().int().positive().default(120),
  cooldownSeconds: z.number().int().nonnegative().default(300),
  minNodes: z.number().int().nonnegative().default(1),
  maxNodes: z.number().int().positive().default(10),
  thresholds: z.object({
    cpuPercent: z.number().min(0).max(100).default(80),
    memoryPercent: z.number().min(0).max(100).default(80),
    diskPercent: z.number().min(0).max(100).optional()
  }),
  selector: z.object({
    labels: nodeLabelsSchema.default({})
  }).default({ labels: {} }),
  proxmox: z.object({
    targetNode: z.string().min(1),
    templateVmId: z.number().int().positive(),
    vmNamePrefix: z.string().min(1).default("autoscaled"),
    cpuCores: z.number().int().positive().default(2),
    memoryMb: z.number().int().positive().default(2048),
    diskGb: z.number().int().positive().optional(),
    pool: z.string().optional(),
    storage: z.string().optional(),
    linkedClone: z.boolean().default(true),
    startOnCreate: z.boolean().default(true),
    tags: z.array(z.string()).default(["pve-vm-autoscaler"])
  })
});

export const scalingDecisionSchema = z.object({
  policyId: z.string(),
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
  policyId: z.string(),
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
export type ScalingPolicy = z.infer<typeof scalingPolicySchema>;
export type ScalingDecision = z.infer<typeof scalingDecisionSchema>;
export type ScalingEvent = z.infer<typeof scalingEventSchema>;

export function labelsMatch(required: NodeLabels, actual: NodeLabels): boolean {
  return Object.entries(required).every(([key, value]) => actual[key] === value);
}
