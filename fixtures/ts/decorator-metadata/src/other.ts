export function usedElsewhere(): number {
  return 1;
}

// Clean dead export, undecorated, unrelated to the decorator-metadata
// mechanism this case exercises: never referenced anywhere.
export function unusedHelper(): number {
  return 0;
}
