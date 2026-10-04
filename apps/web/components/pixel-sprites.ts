/**
 * Pixel sprite data — hand-drawn 16x16 art as character grids.
 *
 * One character = one pixel; `.` is transparent. Colors come from PALETTE so a
 * sprite never carries a hex of its own and the whole set stays inside the
 * product's limited palette (ink, one rose, the milestone state hues, gold for
 * value). Pure data: no React, so it is safe to import from anywhere.
 */

export const PALETTE: Record<string, string> = {
  // rose — the one accent
  r: "#e11d48",
  R: "#fb7185",
  d: "#7f1028",
  // gold — value under escrow
  y: "#fbbf24",
  Y: "#fde68a",
  o: "#b45309",
  // neutrals
  w: "#f4f4f5",
  G: "#d4d4d8",
  g: "#a1a1aa",
  s: "#52525b",
  S: "#27272a",
  // wood
  n: "#92400e",
  N: "#451a03",
  // state hues
  e: "#34d399",
  E: "#047857",
  b: "#60a5fa",
  B: "#1d4ed8",
};

export type SpriteName = "mark" | "coin" | "lock" | "chest" | "sword" | "scroll" | "hourglass" | "shield";

export const SPRITES: Record<SpriteName, string[]> = {
  // brand mark: a shield with a rose lance striking through it
  mark: [
    "................",
    ".GGGGGGGGGGGGGG.",
    ".GSSSSSSSSSSRRG.",
    ".GSSSSSSSSSRRRG.",
    ".GSSSSSSSSRRRSG.",
    ".GSSSSSSSRRRSSG.",
    ".GSSSSSSRRRSSSG.",
    ".GSSSSSRRRSSSSG.",
    ".GSSSSRRRSSSSSG.",
    ".GSSSRRRSSSSSSG.",
    "..GSSRRSSSSSSG..",
    "...GSRSSSSSSG...",
    "....GSSSSSSG....",
    ".....GSSSSG.....",
    "......GGGG......",
    "................",
  ],
  coin: [
    "................",
    ".....oooooo.....",
    "...oyyyyyyyyo...",
    "..oyYYyyyyyyyo..",
    "..oyYyyyooyyyo..",
    ".oyYyyyyooyyyyo.",
    ".oyYyyyyooyyyyo.",
    ".oyyyyyyooyyyyo.",
    ".oyyyyyyooyyyyo.",
    ".oyyyyyyooyyyyo.",
    ".oyyyyyyooyyyyo.",
    "..oyyyyyooyyyo..",
    "..oyyyyyyyyyyo..",
    "...oyyyyyyyyo...",
    ".....oooooo.....",
    "................",
  ],
  lock: [
    "................",
    ".....GGGGGG.....",
    "....GwwwwwwG....",
    "...GwwG..GwwG...",
    "...Gww....wwG...",
    "...Gww....wwG...",
    "...Gww....wwG...",
    "..rrrrrrrrrrrr..",
    "..rRRRRRRRRRRd..",
    "..rRrrrrrrrrrd..",
    "..rRrrrddrrrrd..",
    "..rRrrrddrrrrd..",
    "..rRrrrrddrrrd..",
    "..rRrrrrrrrrrd..",
    "..dddddddddddd..",
    "................",
  ],
  chest: [
    "................",
    "................",
    "...NNNNNNNNNN...",
    "..NnnnnnnnnnnN..",
    ".NnnnnnnnnnnnnN.",
    ".NnnnnnnnnnnnnN.",
    ".yyyyyyyyyyyyyy.",
    ".NnnnnyyyynnnnN.",
    ".NnnnnyoYynnnnN.",
    ".NnnnnnyyynnnnN.",
    ".NnnnnnnnnnnnnN.",
    ".NnnnnnnnnnnnnN.",
    ".NNNNNNNNNNNNNN.",
    "................",
    "................",
    "................",
  ],
  sword: [
    "..............ww",
    ".............wwG",
    "............wwG.",
    "...........wwG..",
    "..........wwG...",
    ".........wwG....",
    "..y.....wwG.....",
    "..yy...wwG......",
    "...yy.wwG.......",
    "....yywG........",
    ".....yyy........",
    "....nnyyy.......",
    "...nn..yy.......",
    "..nn............",
    ".nn.............",
    "................",
  ],
  scroll: [
    "................",
    "...GGGGGGGGG....",
    "...GwwwwwwwGG...",
    "...GwwwwwwwGwG..",
    "...GwrrrrrwGGGG.",
    "...GwwwwwwwwwwG.",
    "...GwsssssssswG.",
    "...GwwwwwwwwwwG.",
    "...GwsssssssswG.",
    "...GwwwwwwwwwwG.",
    "...GwssssswwwwG.",
    "...GwwwwwwwwwwG.",
    "...GGGGGGGGGGGG.",
    "................",
    "................",
    "................",
  ],
  hourglass: [
    "................",
    "...GGGGGGGGGG...",
    "....wwwwwwww....",
    "....wyyyyyyw....",
    ".....wyyyyw.....",
    "......wyyw......",
    ".......ww.......",
    ".......ww.......",
    "......w..w......",
    ".....w.yy.w.....",
    "....w.yyyy.w....",
    "....wyyyyyyw....",
    "....wwwwwwww....",
    "...GGGGGGGGGG...",
    "................",
    "................",
  ],
  shield: [
    "................",
    "..GGGGGGGGGGGG..",
    "..GgggggggggwG..",
    "..GgeeeeeeeewG..",
    "..GgeeeeeeeewG..",
    "..GgeeeeeeeewG..",
    "..GgeeeEEeeewG..",
    "..GgeeEEEEeewG..",
    "..GgeeeEEeeewG..",
    "...GgeeeeeewG...",
    "....GgeeeewG....",
    ".....GgeewG.....",
    "......GGGG......",
    "................",
    "................",
    "................",
  ],
};

/** Bit source for the address sprite: 16 hex chars → 32 two-bit cells. */
export function addressSprite(address: string | null | undefined): { rows: string[]; hue: number } {
  const a = (address ?? "0x0").toLowerCase().replace(/^0x/, "").padEnd(24, "0");
  const hue = parseInt(a.slice(0, 4), 16) % 360;
  const bits = BigInt("0x" + a.slice(4, 20)); // 64 bits
  const rows: string[] = [];
  for (let y = 0; y < 8; y++) {
    let half = "";
    for (let x = 0; x < 4; x++) {
      const v = Number((bits >> BigInt((y * 4 + x) * 2)) & 3n);
      // 0,1 → empty · 2 → body · 3 → shade, so roughly half the cells fill
      half += v < 2 ? "." : v === 2 ? "f" : "d";
    }
    rows.push(half + half.split("").reverse().join(""));
  }
  return { rows, hue };
}
