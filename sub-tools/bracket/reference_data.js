/**
 * sub-tools/bracket/reference_data.js
 * The Commander Format Panel's bracket system is official but deliberately
 * loose beta, reviewed roughly every 3-4 months. Current as of the
 * February 9, 2026 update — re-verify against WotC's Game Changers page if
 * a rating looks off or enough time has passed that a review cycle is likely.
 */

const GAME_CHANGERS = [
  "Drannith Magistrate", "Enlightened Tutor", "Farewell", "Humility", "Serra's Sanctum",
  "Smothering Tithe", "Teferi's Protection", "Consecrated Sphinx", "Cyclonic Rift",
  "Fierce Guardianship", "Force of Will", "Gifts Ungiven", "Intuition", "Mystical Tutor",
  "Narset, Parter of Veils", "Rhystic Study", "Thassa's Oracle", "Ad Nauseam", "Bolas's Citadel",
  "Braids, Cabal Minion", "Demonic Tutor", "Imperial Seal", "Necropotence", "Opposition Agent",
  "Orcish Bowmasters", "Tergrid, God of Fright", "Vampiric Tutor", "Gamble", "Jeska's Will",
  "Underworld Breach", "Biorhythm", "Crop Rotation", "Gaea's Cradle", "Natural Order",
  "Seedborn Muse", "Survival of the Fittest", "Worldly Tutor", "Aura Shards", "Coalition Victory",
  "Grand Arbiter Augustin IV", "Notion Thief", "Ancient Tomb", "Chrome Mox", "Field of the Dead",
  "Glacial Chasm", "Grim Monolith", "Lion's Eye Diamond", "Mana Vault", "Mishra's Workshop",
  "Mox Diamond", "Panoptic Mirror", "The One Ring", "The Tabernacle at Pendrell Vale",
];

const MASS_LAND_DENIAL_CARDS = [
  "Armageddon", "Ravages of War", "Catastrophe", "Jokulhaups", "Obliterate",
  "Decree of Annihilation", "Restore Balance", "Wildfire", "Fall of the Titans",
];

const EXTRA_TURN_CARDS = [
  "Time Warp", "Temporal Manipulation", "Capture of Jingzhou", "Nexus of Fate",
  "Alrund's Epiphany", "Expropriate", "Temporal Trespass", "Time Stretch",
  "Beacon of Tomorrows", "Walk the Aeons", "Part the Waterveil", "Karn's Temporal Sundering",
];

export { GAME_CHANGERS, MASS_LAND_DENIAL_CARDS, EXTRA_TURN_CARDS };
