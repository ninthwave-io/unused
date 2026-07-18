export interface User {
  id: string;
  name: string;
}

// Never re-exported and never referenced anywhere: a plain dead type export,
// for contrast with User below.
export interface Address {
  street: string;
}
