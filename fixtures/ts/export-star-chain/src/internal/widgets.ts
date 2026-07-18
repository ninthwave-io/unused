export function widgetA(): string {
  return "widget-a";
}

// Re-exported through both export-star levels, but never consumed by anything.
export function widgetB(): string {
  return "widget-b";
}
