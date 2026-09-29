import { z } from "zod";
const filterShape = {
  roles_any: z.array(z.string()).optional(),
  effect_in: z.array(z.string()).optional(),
  effects_all: z.array(z.string()).optional(),
  trigger_kind: z.enum(["cast", "activate", "triggered", "static", "replacement"]).optional(),
  trigger_event: z.string().optional().describe("etb, dies, attacks, cast_spell, token_created, counter_added..."),
  trigger_watches: z.object({ type: z.string().optional(), modifier: z.string().optional() }).optional(),
  effect_param_contains: z.object({ key: z.string(), value_contains: z.string() }).optional(),
  cost_contains: z.object({ kind: z.string(), arg: z.string().optional() }).optional(),
  type_line_contains: z.string().optional(),
  name_contains: z.string().optional(),
  oracle_text_contains: z.string().optional(),
  category: z.string().optional(),
  colors_include: z.array(z.string()).optional(),
  cmc_min: z.number().optional(),
  cmc_max: z.number().optional(),
  max_price_usd: z.number().optional()
};
export {
  filterShape
};
