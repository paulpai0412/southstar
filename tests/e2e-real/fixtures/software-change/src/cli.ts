import { add } from "./calc.js";

const [, , command, left, right] = process.argv;

if (command === "add") {
  console.log(String(add(Number(left), Number(right))));
} else {
  console.error("Usage: calc add <a> <b>");
  process.exit(1);
}
