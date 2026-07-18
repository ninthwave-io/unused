// No file in this fixture imports orphan.ts, statically or via side effect.
export function neverCalled(): void {
  console.log("this file is never reached");
}
