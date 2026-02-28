import { detectAllCounties } from './worker/src/lib/geo';

const tests = [
  "Harlan, Letcher, and Perry County officials",
  "Knox/Laurel County",
  "Knox-Laurel-Clay County",
  "Knox and Laurel Counties",
  "Todd County fair is coming",
  "Todd County in Kentucky",
  "Todd County near Ohio River in Kentucky",
];
for (const t of tests) {
  console.log(t, '=>', detectAllCounties(t, t));
}
