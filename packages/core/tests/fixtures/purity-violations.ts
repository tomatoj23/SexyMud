// Deliberate purity violations — never import this file.
// It exists so the engine-purity guard tests can prove the guards themselves
// go red on real offenders (issue #2: "故意违规 fixture 会红").
export const violatingStrings = [
  "闭关之中，修为精进",
  "window.localStorage.getItem",
  "setTimeout(() => {}, 0)",
];
