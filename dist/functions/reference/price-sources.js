const DISPLAY_PRICE_SOURCES = ["tcgplayer", "manapool"];
const DEFAULT_PRICE_SOURCE = "tcgplayer";
function priceFallbackOrder(preferred) {
  if (preferred === "cardkingdom") return ["cardkingdom", ...DISPLAY_PRICE_SOURCES];
  return [preferred, ...DISPLAY_PRICE_SOURCES.filter((s) => s !== preferred)];
}
export {
  DEFAULT_PRICE_SOURCE,
  DISPLAY_PRICE_SOURCES,
  priceFallbackOrder
};
