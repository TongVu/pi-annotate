// Shared silhouette; role variants swap hats and the object the robot holds.
const base = [
  "........AA........", "........tt........", "......HHHHHH......", "......HHHHHH......",
  "......hhhhhh......", "....HHHHHHHHHH....", "...TTTTTTTTTTTT...", "...TVVVVVVVVVVT...",
  "...TVEEVVVVEEVT...", "...TVEEVVVVEEVT...", "...TVVVVVVVVVVT...", "....TTTTTTTTTT....",
  "..TTTTTTTTTTTTTT..", "....TTTATTATTT....", ".....tt....tt.....", ".....tt....tt.....",
];
const ink = { T: "#7db8b0", t: "#5e9a94", V: "#1f2d2f", E: "#9ff2e0", H: "#e3d5a8", h: "#b39b66", C: "#f4efe0", c: "#8a6b3a", K: "#2b393b", k: "#9ff2e0", F: "#d6dcf7", M: "#a9c7f5", m: "#8a6b3a" };
const implementer = {
  2: "......AAAAAA......", 3: "......AAAAAA......", 4: "......aaaaaa......", 5: "....AAAAAAAAAAaa..",
  9: "...TVVVVVVVVVVT...", 12: "....TTTTTTTTTT....", 13: "..TTTTTATTATTTTT..",
  14: "..KKKKKKKKKKKKKK..", 15: "..KkKkKkKkKkKkKk..",
};
const pets = {
  po: ["#e0a030", "#b77816", { 10: "...TVVVVVVVVVVT.c.", 11: "....TTTTTTTTTT.CCC", 12: "..TTTTTTTTTTTTTCAC", 13: "....TTTATTATTT.CAC", 14: ".....tt....tt..CCC" }],
  backend: ["#4fae74", "#2e6f49", implementer],
  frontend: ["#5ca0dc", "#386f99", implementer],
  architect: ["#827de0", "#4b58b0", {
    2: "......AAAAAA......", 3: "....AAAAAAAAAA....", 4: "....AAAAAAAAAA....", 5: "....aaaaaaaaaa....",
    7: "...TFFFFVVFFFFT...", 8: "...TFEEFVVFEEFT...", 9: "...TFEEFVVFEEFT...", 10: "...TFFFFVVFFFFTMMM",
    11: "....TTTTTTTTTT.MVM", 12: "..TTTTTTTTTTTTTMMM", 13: "....TTTATTATTTm...", 14: ".....tt....ttm....",
  }],
  lead: ["#e8805c", "#425b82", { 0: "....A.A.AA.A.A....", 2: "......CCCCCC......", 3: "....CCCCCCCCCC....", 4: "....AAAACCAAAA....", 5: "...aaaaaaaaaaaa...", 10: "...TVVVVVVVVVVT.T.", 11: "....TTTTTTTTTTTT.." }],
};

export function teamPet(id) {
  const [A, a, variant] = pets[id];
  const colors = { ...ink, A, a };
  const pixels = base.flatMap((row, y) => Array.from(variant[y] ?? row, (pixel, x) => {
    if (pixel === ".") return "";
    const cls = pixel === "E" ? 'class="pet-eye"' : pixel === "k" ? `class="pet-key${x % 4 < 2 ? " alt" : ""}"` : "";
    return `<rect x="${x}" y="${y}" width="1" height="1" fill="${colors[pixel]}" ${cls}/>`;
  })).join("");
  return `<svg class="team-pet" viewBox="0 -1 18 17" aria-hidden="true" shape-rendering="crispEdges"><g>${pixels}</g></svg>`;
}
