/**
 * functions/push/game-log.ts -- the ONE place that writes to manaramp's `game_logs` Mongo
 * collection, matching src/lib/server/schema/game_logs.ts in the sibling `manaramp` repo --
 * "owner_user_id: resolved from the API token that pushed this, same as decks.ts." `events` is
 * intentionally untyped/passed through verbatim (whatever shape
 * functions/parsing/gre_match_parser.ts's buildMatchTimeline produced) -- heterogeneous timeline
 * entries, not worth forcing a premature fixed shape on here.
 *
 * Only ever reached from tools/internal-tools.ts's push_game_log wrapper -- the local-stdio
 * arena_game_advice tool has no direct Mongo connection of its own, so that wrapper is the one
 * thing it can reach over HTTP via tools/shared/remote-client.ts. Nothing else calls this directly.
 */

import type { Db } from "mongodb";

interface GameLogDoc {
  _id: string;
  owner_user_id: string;
  deck_id: string | null;
  format: string | null;
  events: Record<string, unknown>[];
  result: string | null;
  logged_at: Date;
}

interface PushGameLogArgs {
  deck_id?: string | null;
  format?: string | null;
  events: Record<string, unknown>[];
  result?: string | null;
}

interface PushGameLogResult {
  game_log_id: string;
}

async function pushGameLog(writeDb: Db, ownerUserId: string, args: PushGameLogArgs): Promise<PushGameLogResult> {
  const doc: GameLogDoc = {
    _id: crypto.randomUUID(),
    owner_user_id: ownerUserId,
    deck_id: args.deck_id ?? null,
    format: args.format ?? null,
    events: args.events,
    result: args.result ?? null,
    logged_at: new Date(),
  };
  await writeDb.collection<GameLogDoc>("game_logs").insertOne(doc);
  return { game_log_id: doc._id };
}

export { pushGameLog };
export type { GameLogDoc, PushGameLogArgs, PushGameLogResult };
