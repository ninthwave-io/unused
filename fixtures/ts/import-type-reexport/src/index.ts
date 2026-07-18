import type { User } from "./types.js";

function printUser(u: User): void {
  console.log(u.name);
}

printUser({ id: "1", name: "Ada" });
