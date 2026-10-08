import { accountOperations } from "./accounts";
import { activityOperations } from "./activity";
import { generateOperations } from "./generate";
import { jobOperations } from "./jobs";
import { mediaOperations } from "./media";
import { openApiOperations } from "./openapi";
import { postOperations } from "./posts";
import { slotOperations } from "./slots";
import { targetOperations } from "./targets";

export * from "./types";

import type { AnyApiOperation } from "./types";

export const OPERATIONS: readonly AnyApiOperation[] = [
  ...accountOperations,
  ...mediaOperations,
  ...postOperations,
  ...targetOperations,
  ...generateOperations,
  ...slotOperations,
  ...jobOperations,
  ...activityOperations,
  ...openApiOperations,
];
